# Sourced by Umbrel before rendering templates and starting Compose.
#
# Oxynote derives its trusted origins, session cookie domain, WebSocket
# origin, invitation links, and MCP OAuth resource from one public origin.
# Bind it to the canonical HTTPS launch address; the proxy service rewrites
# browser traffic so other addresses (LAN IP, Tailscale) work as well. Users
# can override it with OXYNOTE_PUBLIC_URL in the app's Environment settings,
# for example to point MCP clients and invitation links at a Tailscale
# address.
#
# APP_PROXY_PORT is assigned after exports.sh is sourced by Umbrel, so retain
# the manifest's port as a fallback. DEVICE_DOMAIN_NAME is already available.
_oxynote_port="${APP_PROXY_PORT:-8766}"
_oxynote_host="${DEVICE_DOMAIN_NAME:-umbrel.local}"
export APP_OXYNOTE_PUBLIC_URL="https://${_oxynote_host}:${_oxynote_port}"
unset _oxynote_port _oxynote_host
