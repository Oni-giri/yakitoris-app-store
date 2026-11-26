"use strict";

// Chartbrew front door for umbrelOS.
//
// Upstream Chartbrew needs two origins: the React UI on :4018 and the API on
// :4019, with the API URL baked into the UI bundle at build time (the image
// bakes `http://localhost:4019`, and its entrypoint re-runs a multi-minute
// `vite build` on every start to change it). Umbrel's app proxy forwards a
// single port, so this process puts both behind one origin instead:
//
//   /api/*                          -> API, with the /api prefix stripped
//   /api/socket.io/* (WebSocket)    -> API /socket.io/*
//   /mcp, /.well-known/oauth-*,     -> API, unchanged (MCP must live at the
//   /oauth/{authorize,token,          origin root: Chartbrew requires the MCP
//           register,revoke}          resource URL path to be exactly /mcp)
//   everything else                 -> the prebuilt UI, with SPA fallback
//
// At start-up the prebuilt bundle is patched once, in place, so the UI derives
// its API and site URLs from `location.origin` at runtime. That keeps the app
// working from <device>.local, a Tailscale IP, or a .ts.net name without a
// rebuild. Only Node.js core modules are used; nothing is fetched at runtime.

const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const zlib = require("node:zlib");

const DIST = path.resolve(process.env.CB_WEB_DIST || "/code/client/dist");
const PORT = Number(process.env.CB_WEB_PORT || 4018);
const API_HOST = process.env.CB_API_UPSTREAM_HOST || "127.0.0.1";
const API_PORT = Number(process.env.CB_API_UPSTREAM_PORT || 4019);

// ---------------------------------------------------------------------------
// 1. Patch the prebuilt bundle (idempotent; the image's dist is the only copy
//    and every container recreation starts again from the pristine image).
// ---------------------------------------------------------------------------

const RUNTIME_ORIGIN = "${globalThis.location.origin}";
const SOCKET_CALL = "(globalThis.location.origin,{withCredentials:!0,";
const SOCKET_PATH = "path:`/api/socket.io`";

function countOf(haystack, needle) {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) {
    count += 1;
  }
  return count;
}

function patchBundle() {
  const assets = path.join(DIST, "assets");
  let socketCalls = 0;
  let socketPaths = 0;
  let patchedFiles = 0;

  for (const name of fs.readdirSync(assets)) {
    if (!name.endsWith(".js")) continue;
    const file = path.join(assets, name);
    const before = fs.readFileSync(file, "utf8");

    const after = before
      // socket.io-client treats the URL path as the namespace, so it must
      // connect to the bare origin and reach the API through its `path`.
      .replace(
        /this\.socket=([\w$]+)\(([\w$]+),\{withCredentials:!0,/g,
        (match, io) => "this.socket=" + io + SOCKET_CALL
      )
      .split("path:`/socket.io`").join(SOCKET_PATH)
      // Every baked URL sits at the start of a template literal, so it can be
      // swapped for an interpolated runtime origin.
      .split("`http://localhost:4019").join("`" + RUNTIME_ORIGIN + "/api")
      .split("`http://localhost:4018").join("`" + RUNTIME_ORIGIN);

    if (after.includes("localhost:4019") || after.includes("localhost:4018")) {
      throw new Error(name + " still references a baked localhost:4018/4019 URL in an unexpected form");
    }
    if (after !== before) {
      fs.writeFileSync(file, after);
      patchedFiles += 1;
    }
    socketCalls += countOf(after, SOCKET_CALL);
    socketPaths += countOf(after, SOCKET_PATH);
  }

  if (socketCalls !== 1 || socketPaths !== 1) {
    throw new Error(
      "expected exactly one socket.io client call to patch, found " + socketCalls + " call(s) and " + socketPaths + " path(s)"
    );
  }
  return patchedFiles;
}

// ---------------------------------------------------------------------------
// 2. Static UI with SPA fallback.
// ---------------------------------------------------------------------------

const TYPES = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp4": "video/mp4",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webm": "video/webm",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
const COMPRESSIBLE = new Set([".css", ".html", ".js", ".json", ".map", ".mjs", ".svg", ".ttf", ".txt", ".webmanifest"]);
const gzipCache = new Map();

function resolveStatic(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const file = path.join(DIST, path.normalize(decoded));
  if (file !== DIST && !file.startsWith(DIST + path.sep)) return null;
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? { file, stat } : null;
  } catch {
    return null;
  }
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  let start;
  let end;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start > end || start >= size) return "unsatisfiable";
  return { start, end };
}

function sendText(res, status, body, extra) {
  res.writeHead(status, Object.assign({
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  }, extra || {}));
  res.end(body);
}

function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendText(res, 405, "Method Not Allowed\n", { Allow: "GET, HEAD" });
    return;
  }

  let found = pathname === "/" ? null : resolveStatic(pathname);
  if (!found) {
    // Hashed assets and well-known probes must 404 rather than receive the
    // SPA shell; OAuth/MCP clients rely on that to fall back correctly.
    if (pathname.startsWith("/assets/") || pathname.startsWith("/.well-known/")) {
      sendText(res, 404, "Not Found\n");
      return;
    }
    found = resolveStatic("/index.html");
    if (!found) {
      sendText(res, 500, "Chartbrew UI files are missing from the image\n");
      return;
    }
  }

  const { file, stat } = found;
  const ext = path.extname(file).toLowerCase();
  const etag = "W/\"" + stat.size.toString(16) + "-" + Math.floor(stat.mtimeMs).toString(16) + "\"";
  const headers = {
    "Content-Type": TYPES[ext] || "application/octet-stream",
    "Cache-Control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    "ETag": etag,
    "X-Content-Type-Options": "nosniff",
  };
  if (COMPRESSIBLE.has(ext)) headers.Vary = "Accept-Encoding";

  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
    let cached = gzipCache.get(file);
    if (!cached || cached.etag !== etag) {
      cached = { etag, body: zlib.gzipSync(fs.readFileSync(file), { level: 6 }) };
      gzipCache.set(file, cached);
    }
    headers["Content-Encoding"] = "gzip";
    headers["Content-Length"] = cached.body.length;
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : cached.body);
    return;
  }

  headers["Accept-Ranges"] = "bytes";
  let status = 200;
  let start = 0;
  let end = stat.size - 1;
  if (req.headers.range) {
    const range = parseRange(req.headers.range, stat.size);
    if (range === "unsatisfiable") {
      sendText(res, 416, "Range Not Satisfiable\n", { "Content-Range": "bytes */" + stat.size });
      return;
    }
    if (range) {
      status = 206;
      start = range.start;
      end = range.end;
      headers["Content-Range"] = "bytes " + start + "-" + end + "/" + stat.size;
    }
  }
  headers["Content-Length"] = stat.size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === "HEAD" || stat.size === 0) {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file, { start, end });
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

// ---------------------------------------------------------------------------
// 3. Reverse proxy to the API (HTTP, streaming responses, and WebSockets).
// ---------------------------------------------------------------------------

const ROOT_API_PATHS = new Set(["/mcp", "/oauth/authorize", "/oauth/token", "/oauth/register", "/oauth/revoke"]);
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];
const FORWARDED = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"];
const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });

function splitUrl(rawUrl) {
  const q = rawUrl.indexOf("?");
  return q === -1 ? [rawUrl, ""] : [rawUrl.slice(0, q), rawUrl.slice(q)];
}

// Returns the upstream request target, or null when the UI should handle it.
function apiTarget(rawUrl) {
  const [pathname, search] = splitUrl(rawUrl);
  if (pathname === "/api" || pathname.startsWith("/api/")) return (pathname.slice(4) || "/") + search;
  if (ROOT_API_PATHS.has(pathname) || pathname.startsWith("/.well-known/oauth-")) return rawUrl;
  return null;
}

function forwardedValues(req) {
  const peer = req.socket.remoteAddress || "";
  const prior = req.headers["x-forwarded-for"];
  return {
    "x-forwarded-for": prior ? prior + ", " + peer : peer,
    "x-forwarded-host": req.headers["x-forwarded-host"] || req.headers.host || "",
    "x-forwarded-proto": req.headers["x-forwarded-proto"] || "http",
  };
}

function proxyHttp(req, res, target) {
  const headers = Object.assign({}, req.headers);
  for (const name of HOP_BY_HOP) delete headers[name];
  Object.assign(headers, forwardedValues(req));

  const upstream = http.request({ agent, host: API_HOST, port: API_PORT, method: req.method, path: target, headers });

  upstream.on("response", (upstreamRes) => {
    const out = Object.assign({}, upstreamRes.headers);
    for (const name of HOP_BY_HOP) delete out[name];
    res.writeHead(upstreamRes.statusCode, upstreamRes.statusMessage, out);
    // Flush immediately so server-sent events and long AI streams are not held back.
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    upstreamRes.pipe(res);
    upstreamRes.on("error", () => res.destroy());
  });

  upstream.on("error", () => {
    if (!res.headersSent) {
      sendText(
        res,
        502,
        "Chartbrew's API is not reachable yet. It may still be starting or running database migrations; try again in a moment.\n",
        { "Retry-After": "5" }
      );
    } else {
      res.destroy();
    }
  });

  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
}

function proxyUpgrade(req, socket, head) {
  const target = apiTarget(req.url);
  if (!target) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }

  let connected = false;
  const upstream = net.connect(API_PORT, API_HOST);

  const teardown = () => {
    socket.destroy();
    upstream.destroy();
  };
  socket.on("error", teardown);
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
  upstream.on("error", () => {
    if (!connected && socket.writable) {
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
    upstream.destroy();
  });

  upstream.on("connect", () => {
    connected = true;
    socket.setTimeout(0);
    socket.setNoDelay(true);
    upstream.setNoDelay(true);

    const lines = [req.method + " " + target + " HTTP/1.1"];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (!FORWARDED.includes(req.rawHeaders[i].toLowerCase())) {
        lines.push(req.rawHeaders[i] + ": " + req.rawHeaders[i + 1]);
      }
    }
    const forwarded = forwardedValues(req);
    for (const name of FORWARDED) lines.push(name + ": " + forwarded[name]);

    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
}

// ---------------------------------------------------------------------------
// 4. Server.
// ---------------------------------------------------------------------------

function main() {
  const patched = patchBundle();
  console.log("[chartbrew-web] UI bundle ready (" + patched + " file(s) patched this start)");

  const server = http.createServer((req, res) => {
    const target = apiTarget(req.url);
    if (target) {
      proxyHttp(req, res, target);
      return;
    }
    serveStatic(req, res, splitUrl(req.url)[0]);
  });

  // Uploads, AI chats, and MCP calls can legitimately outlive Node's 5-minute default.
  server.requestTimeout = 0;
  server.headersTimeout = 60000;
  server.keepAliveTimeout = 65000;
  server.on("upgrade", proxyUpgrade);
  server.on("clientError", (err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log("[chartbrew-web] listening on :" + PORT + ", API upstream " + API_HOST + ":" + API_PORT);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error("[chartbrew-web] " + (error && error.message ? error.message : error));
    process.exit(1);
  }
}

module.exports = { apiTarget, parseRange, patchBundle };
