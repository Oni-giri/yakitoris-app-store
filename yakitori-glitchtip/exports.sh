# Sourced by Umbrel before rendering templates and starting Compose.
# Each secret has its own derivation label; none is reused for another purpose.

export APP_GLITCHTIP_POSTGRES_PASSWORD="$(derive_entropy "${app_entropy_identifier}-postgres-password")"
# Django SECRET_KEY: signs sessions, CSRF tokens, password-reset links, and
# invitation tokens. Stable per device, so updates never log everyone out.
export APP_GLITCHTIP_SECRET_KEY="$(derive_entropy "${app_entropy_identifier}-secret-key")"

# GlitchTip builds DSNs, email links, and OAuth/MCP metadata from this URL.
# APP_PROXY_PORT is assigned from the manifest; keep its port as a fallback.
# Override it from the app's Environment settings (GLITCHTIP_DOMAIN) to use a
# Tailscale .ts.net name or another hostname instead of <device>.local.
PORT="${APP_PROXY_PORT:-8476}"
LOCAL_DOMAIN="${DEVICE_DOMAIN_NAME:-umbrel.local}"
export APP_GLITCHTIP_DOMAIN="https://${LOCAL_DOMAIN}:${PORT}"
