# Sourced by Umbrel before rendering templates and starting Compose.
# Each secret has its own derivation label; none is reused for another purpose.

export APP_MAXUN_DB_PASSWORD="$(derive_entropy "${app_entropy_identifier}-postgres-password")"
export APP_MAXUN_MINIO_SECRET="$(derive_entropy "${app_entropy_identifier}-minio-secret")"
export APP_MAXUN_JWT_SECRET="$(derive_entropy "${app_entropy_identifier}-jwt-secret")"
export APP_MAXUN_SESSION_SECRET="$(derive_entropy "${app_entropy_identifier}-session-secret")"
# Maxun requires exactly 64 hex characters (an AES-256 key), which is what
# derive_entropy returns.
export APP_MAXUN_ENCRYPTION_KEY="$(derive_entropy "${app_entropy_identifier}-encryption-key")"

# APP_PROXY_PORT is assigned after exports.sh is sourced by Umbrel, so retain
# the manifest's port as a fallback. DEVICE_DOMAIN_NAME is already available.
_maxun_port="${APP_PROXY_PORT:-8767}"
_maxun_host="${DEVICE_DOMAIN_NAME:-umbrel.local}"
export APP_MAXUN_PUBLIC_URL="https://${_maxun_host}:${_maxun_port}"
unset _maxun_port _maxun_host
