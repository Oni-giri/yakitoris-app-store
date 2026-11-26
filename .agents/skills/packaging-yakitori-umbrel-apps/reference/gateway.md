# App gateway: auth, HTTPS, origins, MCP

On umbrelOS 2.x, `app_proxy` is not a container. umbreld reads its environment and serves the manifest `port` through an in-process gateway.

## Contents
- app_proxy keys
- Auth model and whitelist semantics
- Whitelist audit (mandatory)
- HTTP and HTTPS on one port
- Canonical URL and trusted origins
- Headers the app receives
- MCP and OAuth endpoints
- WebSockets, streaming, uploads

## app_proxy keys

Only these keys are read. Anything else, such as `PROXY_TRUST_PROXY`, is silently ignored. A file `${APP_DATA_DIR}/.env.app_proxy` would override them, so never ship one.

| Key | Meaning |
|---|---|
| `APP_HOST` | `<app-id>_<service>_1` of the web service. Required. |
| `APP_PORT` | The container's listening port, a single integer. Required. |
| `APP_PROTOCOL` | `https` when the upstream serves TLS. Its certificate **is verified**, so a self-signed upstream fails. Avoid; serve plain HTTP internally. |
| `PROXY_AUTH_ADD` | Umbrel login is on unless this is `"false"` (trimmed, case-insensitive). Do not set `"true"`; that is the default. |
| `PROXY_AUTH_WHITELIST` | Paths that skip Umbrel login, comma- or space-separated. |
| `PROXY_AUTH_BLACKLIST` | Exceptions carved out of the whitelist. It has no effect on its own. |
| `PROXY_TRUST_UPSTREAM` | `"true"` passes client `X-Forwarded-*` through unchanged. Almost never wanted. |
| `PROXY_TIMEOUT` | Upstream response timeout in **milliseconds**. Unset or 0 means **no timeout**, which is already right for MCP streams, SSE, long exports and LLM responses. Set it only to impose a cap. |

## Auth model and whitelist semantics

- **Unauthenticated requests:**
  - HTTP gets a 302 to `<host>:2000/app-auth`.
  - WebSocket upgrades get a 401.
  - After the user logs in, a `POST /umbrel_/api/v1/auth/handoff` on the app's port sets the cookie. The app must not use that path.
- **The owner can switch "Require Umbrel login" off per app.** Still design the package as if it stays on.
- **Matching rules.** Paths are normalized first: query string stripped, duplicate slashes merged, trailing slash ignored. Matching is case-sensitive.

| Pattern | Matches |
|---|---|
| `/mcp` | exactly `/mcp` (and `/mcp/`) |
| `/mcp/*` | `/mcp/anything`, but **not** `/mcp` itself |
| `/api*` | every path starting with `/api`, **including `/apikeys`, `/api-admin`** |
| `/*` or `*` | everything (never use) |

- **Always write both forms**: `"/mcp,/mcp/*"`. Avoid the `/x*` form, which matches more than you think.
- **A request is public when** its path matches the whitelist and does not match the blacklist.
- **Example**, protecting an internal endpoint inside a public API:

```yaml
      PROXY_AUTH_WHITELIST: "/api/v1,/api/v1/*,/mcp,/mcp/*"
      PROXY_AUTH_BLACKLIST: "/api/v1/admin,/api/v1/admin/*"
```

## Whitelist audit (mandatory)

Treat every whitelisted path as public on the LAN, and over Tor if the user enables it. Before shipping a whitelist, answer each question below in the compose header comment:

1. **Who calls it?** Typical callers are SDKs, CLI tools, MCP clients, webhooks, calendar or CalDAV clients, mobile apps, and OAuth token exchange. A browser page that the user opens is not a valid reason, because the user is logged in.
2. **What authenticates it?** It must be an API key, bearer token, signature or per-resource unguessable token that is **checked by the app on every route under the prefix**.
3. **What else lives under the prefix?** Read the upstream router at the pinned tag. A broad prefix such as `/api/*` typically also contains:
   - sign-up and registration (often "first account becomes admin")
   - admin bootstrap or setup endpoints
   - password reset
   - health or debug endpoints that leak config
   - framework catch-alls. Next.js 404 handlers execute Server Actions, which once exposed full read/write access through `/mcp/*`.
4. **Can it be narrower?** List exact routes, or put an nginx router in front and allow only those routes and methods (`limit_except`). Return 404 for the rest; see yakitori-mcpspan.

Disclose every bypass in the manifest `description`, under ⚠️ GOOD TO KNOW.

`PROXY_AUTH_ADD: "false"` is acceptable only when the app has mandatory auth on **every** route, including first-run setup. Even then, prefer a whitelist.

## HTTP and HTTPS on one port

- **Protocol detection.** The manifest port answers both plain HTTP and TLS, by sniffing the first bytes. Umbrel terminates TLS with its own local CA, which browsers do not trust until the user installs it.
- **No redirect.** There is no HTTP→HTTPS redirect, and HSTS headers from the app are stripped.
- **What `requiresHttps: true` does.** It only makes the dashboard open the `https://` URL. Machine clients may still use `http://` on the same port. This matters for SDKs and agents that reject Umbrel's CA, so do not break plain HTTP for API and MCP paths.
- **When to set it.** Set `requiresHttps: true` and build the canonical URL with `https://` when the app:
  - uses Secure cookies
  - requires a secure context
  - validates the request origin against an https URL

## Canonical URL and trusted origins

Users reach the app at `<device>.local`, the LAN IP, a Tailscale name, or `.onion`. Avoid needing a fixed URL at all when upstream can derive URLs from the request (`Host` and `X-Forwarded-Proto`). When upstream needs a base URL:

```sh
# exports.sh
_example_port="${APP_PROXY_PORT:-8790}"          # APP_PROXY_PORT is not set yet when exports.sh runs
_example_host="${DEVICE_DOMAIN_NAME:-umbrel.local}"
export APP_EXAMPLE_URL="https://${_example_host}:${_example_port}"
unset _example_port _example_host
```

```yaml
# compose
      PUBLIC_URL: ${APP_EXAMPLE_URL}
```

Then add these:

- **An override.** Add a manifest `environment:` entry for the same variable (`PUBLIC_URL`, `BETTER_AUTH_URL`, ...) so users can switch to their Tailscale address. Umbrel's certificate covers the hostname, `.local` names and the device's IPv4 addresses, but **not** `*.ts.net` names. For https over Tailscale, suggest the Tailscale IP or a `tailscale serve` address.
- **Trusted-origin lists**, when upstream accepts them. Include the `https://` and `http://` forms of the canonical origin, plus an override variable. Never use `*` and never disable CSRF.
- **Keep the fallback port in sync.** The fallback port in `exports.sh` duplicates the manifest `port`. When the port changes, change both.

## Headers the app receives

- **`Host`** is preserved, including the port.
- **`X-Forwarded-Proto`** is `https` when Umbrel terminated TLS, `http` otherwise. **`X-Forwarded-Host`** is set too.
- **`X-Forwarded-For` is always `127.0.0.1`.** The app never sees client IPs. Per-IP rate limiting is therefore global, so raise or disable it. IP allow-lists do not work.
- **Umbrel's session cookies are stripped.** The app's own cookies pass through unchanged.
- **Configure the trusted proxy.** The TCP peer the app sees is the Docker gateway, `10.21.0.1`, not loopback. If the app needs a trusted-proxy setting, trust `${NETWORK_IP:-10.21.0.0}/16`.
- **Never grant "local" trust.** Because `X-Forwarded-For` is `127.0.0.1` for every request, an app that skips auth or grants admin to localhost clients would do so for everyone, including requests on whitelisted public paths. Disable such a feature.
- **Intermediate nginx or Caddy routers** must forward `X-Forwarded-Proto` from the gateway rather than overwrite it with `http`. Otherwise the app advertises `http://` URLs, and MCP OAuth audience checks fail. You can also route `APP_HOST` straight to the app server and bypass the image's bundled proxy.

## MCP and OAuth endpoints

Many apps in this store expose MCP servers. The typical public set is:

```
/mcp,/mcp/*,
/.well-known/oauth-protected-resource,/.well-known/oauth-protected-resource/*,
/.well-known/oauth-authorization-server,/.well-known/oauth-authorization-server/*,
/.well-known/openid-configuration,
<token>,<register>,<revoke>,<jwks> endpoints (exact paths)
```

- **The authorize and consent page stays behind Umbrel login.** The user opens it in a logged-in browser.
- **Verify that the advertised resource URL matches the URL clients use.** Check scheme, host and port: `curl -s https://<device>.local:<port>/.well-known/oauth-protected-resource`.
- **Leave `PROXY_TIMEOUT` unset.** The gateway has no timeout by default. Inner nginx routers still need `proxy_read_timeout` and `proxy_buffering off` for streamable HTTP and SSE.
- **Cloud MCP connectors cannot reach the app.** claude.ai, ChatGPT and other hosted clients cannot open a `.local` or LAN address. Say in the description that only clients on the user's network (or tailnet) can connect.
- **If the MCP server uses a static bearer token instead of OAuth**, wire it to `${APP_PASSWORD}`, set `deterministicPassword: true` so Umbrel shows it, and document how to connect.

## WebSockets, streaming, uploads

- **WebSockets** work through the gateway with no configuration. Unauthenticated upgrades get a 401, not a redirect.
- **Request bodies** have no size or time limit at the gateway. Inner nginx routers need `client_max_body_size`, and `proxy_buffering off` for streaming.
- **The gateway route only exists while `APP_HOST:APP_PORT` accepts TCP.** A web service that takes minutes to start shows "connection refused" until it is ready. Before that it shows nothing, and after a crash the user gets a 502 page.
