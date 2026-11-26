# Umbrel sources this before rendering templates and starting Compose. Being
# sourced, it must not change shell options or leave helpers behind in Umbrel's
# shell. Each secret has its own derivation label; none is reused.

# better-auth signs sessions, OAuth state, and MCP tokens with this. Stable per
# device, so restarts and updates never sign anyone out.
export APP_KEEPER_AUTH_SECRET="$(derive_entropy "${app_entropy_identifier}-better-auth-secret")"

# Keeper encrypts stored CalDAV, iCloud, and Fastmail passwords with NaCl
# secretbox and requires ENCRYPTION_KEY to be base64 of exactly 32 bytes;
# anything else fails when a CalDAV account is added or synced. derive_entropy
# prints a SHA-256 HMAC as 64 hex characters (32 bytes), so decode the hex to
# raw bytes and base64 them. The key must never change, or every stored
# CalDAV password becomes unreadable.
_keeper_hex="$(derive_entropy "${app_entropy_identifier}-encryption-key")"
export APP_KEEPER_ENCRYPTION_KEY="$(printf "$(printf '%s' "${_keeper_hex}" | sed 's/../\\x&/g')" | base64 | tr -d '\n')"

# Keeper's public origin: auth redirects, Secure cookies, OAuth callbacks, iCal
# feed links, and the MCP resource URL (BETTER_AUTH_URL + /mcp) all derive from
# it. Bind it to the canonical HTTPS launch address. Override BETTER_AUTH_URL in
# the app's Environment settings to use a Tailscale .ts.net or other hostname.
# APP_PROXY_PORT is assigned after exports.sh is sourced, so keep the manifest
# port as a fallback. DEVICE_DOMAIN_NAME is already available.
_keeper_port="${APP_PROXY_PORT:-8792}"
_keeper_host="${DEVICE_DOMAIN_NAME:-umbrel.local}"
export APP_KEEPER_URL="https://${_keeper_host}:${_keeper_port}"

unset _keeper_hex _keeper_port _keeper_host
