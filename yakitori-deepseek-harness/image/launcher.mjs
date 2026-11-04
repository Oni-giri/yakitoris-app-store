// Umbrel launcher for DeepSeek Harness (dsh).
//
// dsh's Web UI only listens on one concrete address and authenticates browsers
// with a random launch token that it prints once per process. Umbrel opens apps
// through its own authenticated app_proxy, which knows nothing about that token.
// This launcher bridges the two:
//
//   1. Runs `dsh web` (installed into the image at build time) on loopback
//      inside the container.
//   2. Serves a small reverse proxy on LISTEN_PORT for app_proxy. It forwards
//      every request and WebSocket upgrade to dsh with Host/Origin rewritten to
//      the loopback authority, and hands the launch token over on `GET /`, so the
//      browser receives dsh's own signed session cookie.
//
// Access control is therefore Umbrel's login (app_proxy), as for any Umbrel app.
// Only Node built-ins are used.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.DATA_DIR ?? '/data'
const LISTEN_HOST = process.env.LISTEN_HOST ?? '0.0.0.0' // app_proxy reaches us over the Docker network
const LISTEN_PORT = Number(process.env.LISTEN_PORT ?? 8080)
const DSH_PORT = Number(process.env.DSH_PORT ?? 3081)
const DSH_HOST = '127.0.0.1'
const UPSTREAM = `${DSH_HOST}:${DSH_PORT}`

const WORKSPACE_DIR = process.env.DSH_WORKSPACE ?? path.join(DATA_DIR, 'workspace')
const DSH_HOME = process.env.DSH_HOME ?? path.join(DATA_DIR, 'home')
const DSH_BIN = process.env.DSH_BIN ?? path.join(HERE, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const log = (...args) => console.log('[launcher]', ...args)

for (const dir of [WORKSPACE_DIR, DSH_HOME]) mkdirSync(dir, { recursive: true })

// The first release of this app installed dsh into the data folder at startup.
// The image carries it now, so drop that copy and its npm cache.
for (const stale of ['runtime', 'npm-cache']) {
  const dir = path.join(DATA_DIR, stale)
  if (existsSync(dir)) {
    log(`removing ${dir} (no longer used)`)
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---- state shown to the browser while dsh is not ready ----------------------

let phase = 'launching' // launching | ready
let launchToken

function statusPage(res) {
  res.writeHead(503, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    refresh: '2',
    'retry-after': '2',
  })
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeepSeek Harness</title>
<style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0f1115;color:#e6e6e6}
main{max-width:32rem;padding:2rem;text-align:center}p{opacity:.8;line-height:1.5}</style>
<main><h1>DeepSeek Harness</h1><p>Starting…</p><p>This page refreshes automatically.</p></main>`)
}

// ---- reverse proxy ------------------------------------------------------------

function upstreamHeaders(headers) {
  const out = { ...headers, host: UPSTREAM }
  // dsh's fence compares Origin with Host; the browser's real origin is the
  // Umbrel address, which dsh is not told about. app_proxy already enforced the
  // Umbrel login, and the browser still enforces same-origin for this page.
  if (out.origin) out.origin = `http://${UPSTREAM}`
  if (out.referer) {
    try {
      const ref = new URL(out.referer)
      out.referer = `http://${UPSTREAM}${ref.pathname}${ref.search}`
    } catch {
      delete out.referer
    }
  }
  if (out['sec-fetch-site'] === 'cross-site') out['sec-fetch-site'] = 'same-origin'
  return out
}

function targetPath(req) {
  const url = new URL(req.url, 'http://x')
  return url.pathname + url.search
}

function withToken(pathAndQuery) {
  const url = new URL(pathAndQuery, 'http://x')
  url.searchParams.set('token', launchToken)
  return url.pathname + url.search
}

const hasSessionCookie = (req) => /(?:^|;\s*)dsh-auth-[^=]*=/.test(req.headers.cookie ?? '')

// The document entry `GET /`: the only place dsh accepts the launch token. A
// browser without a dsh session cookie gets the token handed over (dsh answers
// with its signed cookie and a redirect to `./`, so the token never reaches the
// address bar). A browser with a cookie is forwarded as-is, and only if dsh
// rejects that cookie (expired, or signed before a reset) is the token used.
function isEntry(req) {
  return req.method === 'GET' && new URL(req.url, 'http://x').pathname === '/'
}

function forward(req, res, pathAndQuery, { body = true, onReject } = {}) {
  const upstream = http.request(
    { host: DSH_HOST, port: DSH_PORT, method: req.method, path: pathAndQuery, headers: upstreamHeaders(req.headers) },
    (up) => {
      if (onReject && (up.statusCode === 401 || up.statusCode === 403)) {
        up.resume()
        return onReject()
      }
      res.writeHead(up.statusCode ?? 502, up.statusMessage, up.rawHeaders)
      up.pipe(res)
    },
  )
  upstream.on('error', (err) => {
    log('upstream error:', err.message)
    if (!res.headersSent) statusPage(res)
    else res.destroy()
  })
  if (body) req.pipe(upstream)
  else upstream.end()
}

const server = http.createServer((req, res) => {
  if (phase !== 'ready') return statusPage(res)
  const target = targetPath(req)
  if (!isEntry(req) || new URL(req.url, 'http://x').searchParams.has('token')) return forward(req, res, target)
  if (!hasSessionCookie(req)) return forward(req, res, withToken(target), { body: false })
  forward(req, res, target, { body: false, onReject: () => forward(req, res, withToken(target), { body: false }) })
})

server.on('upgrade', (req, socket, head) => {
  if (phase !== 'ready') return socket.destroy()
  const upstream = net.connect(DSH_PORT, DSH_HOST, () => {
    const headers = upstreamHeaders(req.headers)
    let raw = `${req.method} ${targetPath(req)} HTTP/${req.httpVersion}\r\n`
    for (const [name, value] of Object.entries(headers)) {
      for (const v of Array.isArray(value) ? value : [value]) raw += `${name}: ${v}\r\n`
    }
    upstream.write(raw + '\r\n')
    if (head?.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  const close = () => { socket.destroy(); upstream.destroy() }
  upstream.on('error', close)
  socket.on('error', close)
})

server.listen(LISTEN_PORT, LISTEN_HOST, () => log(`proxy listening on ${LISTEN_HOST}:${LISTEN_PORT}`))

// ---- run dsh -------------------------------------------------------------------

let child
let stopping = false

function startDsh() {
  phase = 'launching'
  launchToken = undefined
  child = spawn(process.execPath, [
    DSH_BIN, 'web', '--no-open', '--host', DSH_HOST, '--port', String(DSH_PORT),
  ], {
    cwd: WORKSPACE_DIR,
    env: { ...process.env, DSH_HOME },
    stdio: ['ignore', 'pipe', 'inherit'],
  })

  let buffered = ''
  child.stdout.on('data', (chunk) => {
    buffered += chunk.toString()
    let nl
    while ((nl = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, nl)
      buffered = buffered.slice(nl + 1)
      const match = /[?&]token=([A-Za-z0-9_-]+)/.exec(line)
      if (match && !launchToken) {
        launchToken = match[1]
        phase = 'ready'
        log('dsh is ready')
      }
      // Never write the launch token to the container log.
      console.log(line.replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1<redacted>'))
    }
  })

  child.on('exit', (code, signal) => {
    phase = 'launching'
    launchToken = undefined
    if (stopping) return
    log(`dsh exited (${signal ?? code}); restarting in 3s`)
    setTimeout(startDsh, 3000)
  })
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    stopping = true
    server.close()
    if (child && child.exitCode === null) {
      child.once('exit', () => process.exit(0))
      child.kill('SIGTERM')
      setTimeout(() => process.exit(0), 20000).unref()
    } else process.exit(0)
  })
}

startDsh()
