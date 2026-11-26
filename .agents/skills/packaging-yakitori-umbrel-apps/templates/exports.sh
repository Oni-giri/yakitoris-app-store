# Sourced by Umbrel (set -euo pipefail) before rendering templates and starting
# Compose. It must not change shell options, exit, cd, or leave helpers behind.
# Each secret has its own derivation label; never change a label after release.

export APP_EXAMPLE_DB_PASSWORD="$(derive_entropy "${app_entropy_identifier}-db-password")"
export APP_EXAMPLE_SESSION_SECRET="$(derive_entropy "${app_entropy_identifier}-session-secret")"

# Canonical origin. APP_PROXY_PORT is assigned after this file is sourced, so
# keep the manifest port as a fallback (change both together). Users override
# PUBLIC_URL in the app's settings: a manifest environment: entry replaces the
# container variable of the same name, so it must match the compose key.
_example_port="${APP_PROXY_PORT:-8790}"
_example_host="${DEVICE_DOMAIN_NAME:-umbrel.local}"
export APP_EXAMPLE_URL="https://${_example_host}:${_example_port}"
export APP_EXAMPLE_TRUSTED_PROXIES="${NETWORK_IP:-10.21.0.0}/16"

unset _example_port _example_host
