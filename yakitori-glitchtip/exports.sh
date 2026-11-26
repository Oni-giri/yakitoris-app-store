# Sourced by Umbrel before rendering templates and starting Compose.
# Each secret has its own derivation label; none is reused for another purpose.

export APP_GLITCHTIP_POSTGRES_PASSWORD="$(derive_entropy "${app_entropy_identifier}-postgres-password")"
# Valkey sits on Umbrel's shared Docker network, so any other app's container
# could otherwise read GlitchTip's login sessions and cached tokens.
export APP_GLITCHTIP_VALKEY_PASSWORD="$(derive_entropy "${app_entropy_identifier}-valkey-password")"
# Django SECRET_KEY: signs sessions, CSRF tokens, password-reset links, and
# invitation tokens. Stable per device, so updates never log everyone out.
export APP_GLITCHTIP_SECRET_KEY="$(derive_entropy "${app_entropy_identifier}-secret-key")"

# GlitchTip builds DSNs, email links, and OAuth/MCP metadata from this URL.
# APP_PROXY_PORT is not exported yet when Umbrel sources this file, so the
# fallback (the manifest port) is what applies; keep the two in sync. Users can
# override GLITCHTIP_DOMAIN from the app's Environment settings, e.g. with the
# device's Tailscale IP, which Umbrel's certificate covers.
_glitchtip_port="${APP_PROXY_PORT:-8476}"
_glitchtip_host="${DEVICE_DOMAIN_NAME:-umbrel.local}"
export APP_GLITCHTIP_DOMAIN="https://${_glitchtip_host}:${_glitchtip_port}"
unset _glitchtip_port _glitchtip_host
