# Sourced by Umbrel before rendering templates and starting Compose. Being
# sourced into Umbrel's shell, it only exports app-prefixed variables.
#
# Aldine builds the PDF and deep links its MCP server hands out, OAuth issuer
# metadata, and email links from one public origin. Bind it to the canonical
# HTTPS launch address. Users can override it with ALDINE_PUBLIC_URL in the
# app's Environment settings, for example with a Tailscale address.
#
# APP_PROXY_PORT is assigned after exports.sh is sourced, so keep the
# manifest's port as a fallback. DEVICE_DOMAIN_NAME is already available.
export APP_YAKITORI_ALDINE_PUBLIC_URL="https://${DEVICE_DOMAIN_NAME:-umbrel.local}:${APP_PROXY_PORT:-8480}"
