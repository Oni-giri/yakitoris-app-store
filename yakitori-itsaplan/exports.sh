# Sourced by Umbrel before rendering templates and starting Compose.
# Each secret has its own derivation label; none is reused for another purpose.

export APP_ITSAPLAN_POSTGRES_PASSWORD="$(derive_entropy "${app_entropy_identifier}-postgres-password")"
export APP_ITSAPLAN_AUTH_SECRET="$(derive_entropy "${app_entropy_identifier}-better-auth-secret")"
export APP_ITSAPLAN_ENCRYPTION_KEY="$(derive_entropy "${app_entropy_identifier}-app-encryption-key")"
export APP_ITSAPLAN_S3_SECRET="$(derive_entropy "${app_entropy_identifier}-s3-secret")"

# APP_PROXY_PORT is assigned after exports.sh is sourced by Umbrel, so retain
# the manifest's port as a fallback. DEVICE_DOMAIN_NAME is already available.
PORT="${APP_PROXY_PORT:-8743}"
LOCAL_DOMAIN="${DEVICE_DOMAIN_NAME:-umbrel.local}"
export APP_ITSAPLAN_PUBLIC_ORIGIN="https://${LOCAL_DOMAIN}:${PORT}"
export APP_ITSAPLAN_API_URL="${APP_ITSAPLAN_PUBLIC_ORIGIN}/api"

# Never let TRUSTED_PROXIES expand to a malformed "/16" when NETWORK_IP is unset.
export APP_ITSAPLAN_TRUSTED_PROXIES="${NETWORK_IP:-10.21.0.0}/16"
