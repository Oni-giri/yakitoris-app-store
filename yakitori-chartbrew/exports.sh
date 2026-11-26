# Sourced by Umbrel before rendering templates and starting Compose.
# Each secret has its own derivation label; none is reused for another purpose.

export APP_CHARTBREW_DB_PASSWORD="$(derive_entropy "${app_entropy_identifier}-postgres-password")"
export APP_CHARTBREW_REDIS_PASSWORD="$(derive_entropy "${app_entropy_identifier}-redis-password")"

# Chartbrew requires CB_ENCRYPTION_KEY to be a 64-character hex string (a raw
# 256-bit AES key), which is exactly what derive_entropy returns. It encrypts
# stored data-source credentials and signs sessions, API keys, and share
# tokens, so it must stay stable across updates.
export APP_CHARTBREW_ENCRYPTION_KEY="$(derive_entropy "${app_entropy_identifier}-encryption-key")"
# Legacy field-encryption password (CB_SECRET). Chartbrew still reads it, and
# without a value in the environment it would mint a random one into the
# container's /code/.env, which is lost whenever the container is recreated.
export APP_CHARTBREW_SECRET="$(derive_entropy "${app_entropy_identifier}-secret")"
export APP_CHARTBREW_BULLMQ_PASSWORD="$(derive_entropy "${app_entropy_identifier}-bullmq-password")"

# Canonical HTTPS origin for server-generated links (emails, MCP/OAuth metadata,
# Slack callbacks). APP_PROXY_PORT is assigned after exports.sh is sourced, so
# keep the manifest port as a fallback. Override with CB_SITE_URL in settings.
PORT="${APP_PROXY_PORT:-4018}"
LOCAL_DOMAIN="${DEVICE_DOMAIN_NAME:-umbrel.local}"
export APP_CHARTBREW_SITE_URL="https://${LOCAL_DOMAIN}:${PORT}"
