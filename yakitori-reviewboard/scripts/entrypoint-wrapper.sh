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

# Relax ALLOWED_HOSTS. settings_local.py is plain Python, so a trailing
# assignment wins; this is idempotent across restarts.
if ! grep -q "^ALLOWED_HOSTS = \['\*'\]" "$SETTINGS_LOCAL"; then
    echo "ALLOWED_HOSTS = ['*']" >> "$SETTINGS_LOCAL"
fi

# Hand off to the real entrypoint, which runs an (idempotent) upgrade and then
# starts the server with the command passed below ("/serve.sh").
exec /docker-entrypoint.sh "$@"
