#!/usr/bin/env bash
# Umbrel sources this before the app's compose runs.
#
# Doop builds its public origin from BETTER_AUTH_URL and rejects sign-in and
# API requests whose Origin is not in TRUSTED_ORIGINS. A fixed hostname breaks
# every other way of opening the app, so derive the origin from where the user
# actually launched it. Umbrel provides:
#
#   DEVICE_DOMAIN_NAME  device .local domain (e.g. umbrel.local)
#   APP_DOMAIN          app domain used for remote access, when enabled
#   APP_PROXY_PORT      manifest port
#   APP_HIDDEN_SERVICE  Tor hidden service, when enabled
#
# Users may open the app over http:// or https://, on the device domain, the
# remote domain, or any device hostname, so trust each of those narrow origins
# explicitly rather than disabling the CSRF check.

set -u

PORT="${APP_PROXY_PORT:-4400}"
LOCAL_DOMAIN="${DEVICE_DOMAIN_NAME:-umbrel.local}"
APP_DOMAIN="${APP_DOMAIN:-}"
APP_HIDDEN_SERVICE="${APP_HIDDEN_SERVICE:-}"

# Primary origin: what Doop advertises in redirect and OAuth URLs. Prefer the
# remote domain, because that is the canonical URL when remote access is on.
if [ -n "${APP_DOMAIN}" ]; then
  export APP_DOOP_URL="https://${APP_DOMAIN}"
else
  export APP_DOOP_URL="http://${LOCAL_DOMAIN}:${PORT}"
fi

# Additional origins users can legitimately open the app from.
CANDIDATES="http://${LOCAL_DOMAIN}:${PORT} https://${LOCAL_DOMAIN}:${PORT}"
if [ -n "${APP_DOMAIN}" ]; then
  CANDIDATES="${CANDIDATES} http://${APP_DOMAIN} https://${APP_DOMAIN}"
fi
if [ -n "${APP_HIDDEN_SERVICE}" ]; then
  CANDIDATES="${CANDIDATES} http://${APP_HIDDEN_SERVICE}"
fi

# De-duplicate, drop the primary, and join with commas for Doop's list parser.
ALT=""
for origin in ${CANDIDATES}; do
  [ "${origin}" = "${APP_DOOP_URL}" ] && continue
  case ",${ALT}," in
  *",${origin},"*) ;;
  *) ALT="${ALT:+${ALT},}${origin}" ;;
  esac
done

export APP_DOOP_URL_ALT="${ALT}"
