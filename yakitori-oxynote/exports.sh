# Sourced by Umbrel before rendering templates and starting Compose.
#
# Oxynote derives its trusted origins, session cookie domain, WebSocket
# origin, invitation links, and MCP OAuth resource from one public origin.
# Bind it to the canonical HTTPS launch address. Users can override it with
# OXYNOTE_PUBLIC_URL in the app's Environment settings, for example to use a
# Tailscale .ts.net address.
#
# APP_PROXY_PORT is assigned after exports.sh is sourced by Umbrel, so retain
# the manifest's port as a fallback. DEVICE_DOMAIN_NAME is already available.
PORT="${APP_PROXY_PORT:-8766}"
LOCAL_DOMAIN="${DEVICE_DOMAIN_NAME:-umbrel.local}"
export APP_OXYNOTE_PUBLIC_URL="https://${LOCAL_DOMAIN}:${PORT}"
