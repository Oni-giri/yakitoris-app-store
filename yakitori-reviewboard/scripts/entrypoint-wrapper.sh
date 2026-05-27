#!/bin/bash
#
# Umbrel entrypoint wrapper for Review Board.
#
# Review Board bakes a strict Django ALLOWED_HOSTS into a persisted
# settings_local.py the first time the site is created, derived from the DOMAIN
# env var (plus 127.0.0.1). On Umbrel the very same app is reached via both
# "umbrel.local" and the box's LAN IP, so any single fixed host leads to
# "Bad Request (400): DisallowedHost" errors depending on how you open it.
#
# Since the app already sits behind Umbrel's authenticated app_proxy on a private
# LAN, we relax ALLOWED_HOSTS to accept any host. We must do this as root (the
# settings file is root-owned) and before the web server starts, so we drive the
# image's own /docker-entrypoint.sh rather than replacing it.
set -e

SETTINGS_LOCAL=/site/conf/settings_local.py

# Wait for a *stable* authenticated database connection before doing any work.
#
# On a fresh Umbrel install the Postgres container takes a while to initialize
# and can briefly flap (we've seen it answer on several IPs, alternating between
# "connection refused" and momentary auth failures, before settling). The image's
# own WAIT_FOR_DB only probes once, so it races ahead the instant the DB first
# blinks alive and then rb-site install/upgrade crashes against the not-yet-ready
# server. Requiring several consecutive successful connections proves the DB has
# actually settled. We do our own wait and disable the image's single-shot one.
export WAIT_FOR_DB=no

wait_for_db() {
    local streak=0 attempts=0
    until [ "$streak" -ge 5 ]; do
        if PGPASSWORD="$DATABASE_PASSWORD" psql \
               -h "$DATABASE_SERVER" -U "$DATABASE_USERNAME" "$DATABASE_NAME" \
               -c '\q' >/dev/null 2>&1; then
            streak=$((streak + 1))
        else
            streak=0
        fi
        attempts=$((attempts + 1))
        if [ "$attempts" -ge 300 ]; then
            echo "Database did not become ready after 300 attempts; giving up." >&2
            return 1
        fi
        sleep 1
    done
}

echo "Waiting for a stable database connection..."
wait_for_db
echo "Database is ready."

if [ ! -e "$SETTINGS_LOCAL" ]; then
    # First boot only: let Review Board's real entrypoint create the site
    # directory (install + migrations) without starting the web server. Passing
    # /bin/true as the command makes it return control to us once init is done.
    /docker-entrypoint.sh /bin/true
fi

# Apply Umbrel-specific overrides once. settings_local.py is plain Python imported
# last, so these assignments win over rb-site's generated values:
#   * ALLOWED_HOSTS — accept any host (we sit behind Umbrel's authenticated proxy,
#     reached via umbrel.local, a Tailscale name, or the LAN IP interchangeably).
#   * DB / cache host — pin to unique container names. All Umbrel apps share one
#     Docker network, so the bare "db"/"memcached" names collide with other apps
#     and the backend would authenticate against the wrong database (see compose).
# Fresh installs already get the right DB/cache host from the environment; this
# repairs existing installs that baked "db"/"memcached:11211" into the file.
if ! grep -qF "Umbrel overrides (managed)" "$SETTINGS_LOCAL"; then
    cat >> "$SETTINGS_LOCAL" <<'PYEOF'

# --- Umbrel overrides (managed by entrypoint-wrapper.sh) ---
ALLOWED_HOSTS = ['*']
DATABASES['default']['HOST'] = 'yakitori-reviewboard_db_1'
CACHES['default']['LOCATION'] = 'yakitori-reviewboard_memcached_1:11211'
PYEOF
fi

# Hand off to the real entrypoint, which runs an (idempotent) upgrade and then
# starts the server with the command passed below ("/serve.sh").
exec /docker-entrypoint.sh "$@"
