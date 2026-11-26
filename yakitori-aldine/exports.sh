# Sourced by Umbrel before rendering templates and starting Compose.
#
# Aldine builds the PDF and deep links its MCP server hands out, OAuth issuer
# metadata, and email links from one public origin. Bind it to the canonical
# HTTPS launch address. Users can override it with ALDINE_PUBLIC_URL in the
# app's Environment settings, for example to use a Tailscale .ts.net address.
#
# APP_PROXY_PORT is assigned from the manifest; keep its port as a fallback.
PORT="${APP_PROXY_PORT:-8480}"
LOCAL_DOMAIN="${DEVICE_DOMAIN_NAME:-umbrel.local}"
export APP_YAKITORI_ALDINE_PUBLIC_URL="https://${LOCAL_DOMAIN}:${PORT}"
