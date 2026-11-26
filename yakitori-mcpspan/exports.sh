# Sourced by Umbrel before rendering templates and starting Compose.
# Each secret has its own derivation label; none is reused for another purpose.

export APP_MCPSPAN_DB_PASSWORD="$(derive_entropy "${app_entropy_identifier}-postgres-password")"
# Mixed into every API key hash before it is stored. Upstream asks for
# `openssl rand -hex 32`, which is the format derive_entropy returns. It must
# never change once keys are issued, and deriving it per device keeps it stable
# across updates without a secret file beside the database.
export APP_MCPSPAN_API_KEY_SECRET="$(derive_entropy "${app_entropy_identifier}-api-key-secret")"

# APP_PROXY_PORT is assigned after exports.sh is sourced by Umbrel, so keep the
# manifest's port as a fallback. Both values can be overridden from the app's
# settings, for example with a Tailscale .ts.net address.
#
# The dashboard (and so MCP clients' OAuth consent page) opens over HTTPS.
# MCP servers send telemetry to the same port over plain HTTP by default,
# because SDKs and agents do not trust Umbrel's local certificate authority.
MCPSPAN_PORT="${APP_PROXY_PORT:-6270}"
MCPSPAN_DOMAIN="${DEVICE_DOMAIN_NAME:-umbrel.local}"
export APP_MCPSPAN_DASHBOARD_URL="https://${MCPSPAN_DOMAIN}:${MCPSPAN_PORT}"
export APP_MCPSPAN_INGEST_URL="http://${MCPSPAN_DOMAIN}:${MCPSPAN_PORT}"
unset MCPSPAN_PORT MCPSPAN_DOMAIN
