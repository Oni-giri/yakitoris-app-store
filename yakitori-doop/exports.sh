# Umbrel sources this before the app's compose runs. Being sourced, it must not
# change shell options or leave helpers behind in Umbrel's shell.
#
# Doop builds its public origin from BETTER_AUTH_URL and only accepts requests
# whose Origin is in TRUSTED_ORIGINS. Umbrel has no variable for the remote
# (Tailscale or custom domain) hostname, so a fixed origin breaks every access
# path except the one it names. Instead:
#
#   APP_DOOP_URL      canonical origin, used for redirect and OAuth URLs
#   APP_DOOP_URL_ALT  every origin users can legitimately open the app from
#
# better-auth accepts wildcard patterns in trusted origins, so the .local
# domain, the remote domain and raw IP addresses are covered without knowing
# the hostname ahead of time. The list stays scoped to the Umbrel device
# instead of trusting every origin.

PORT="${APP_PROXY_PORT:-4400}"
LOCAL_DOMAIN="${DEVICE_DOMAIN_NAME:-umbrel.local}"
APP_HIDDEN_SERVICE="${APP_HIDDEN_SERVICE:-}"

# Canonical origin. Remote access, when on, is the URL the user actually
# opens, so advertise it; otherwise use the local launch origin.
if [ -n "${APP_HIDDEN_SERVICE}" ] && [ "${APP_HIDDEN_SERVICE}" != "not-enabled.onion" ] &&
  [ "${APP_HIDDEN_SERVICE}" != "notyetset.onion" ]; then
  export APP_DOOP_URL="http://${APP_HIDDEN_SERVICE}"
else
  export APP_DOOP_URL="http://${LOCAL_DOMAIN}:${PORT}"
fi

# Origins users can open the app from. Wildcards cover the remote hostname
# (for example <device>.<tailnet>.ts.net) and the .local domain over both
# schemes and the manifest port.
ALT=""
add() {
  case ",${ALT}," in
  *",$1,"*) ;;
  *) ALT="${ALT:+${ALT},}$1" ;;
  esac
}
add "http://${LOCAL_DOMAIN}:${PORT}"
add "https://${LOCAL_DOMAIN}:${PORT}"
add "http://${LOCAL_DOMAIN}"
add "https://${LOCAL_DOMAIN}"
add "*://*.ts.net:*"
add "*://*.ts.net"
add "*://${LOCAL_DOMAIN%%.*}.*:${PORT}"
add "*://${LOCAL_DOMAIN%%.*}.*"
if [ -n "${APP_HIDDEN_SERVICE}" ] && [ "${APP_HIDDEN_SERVICE}" != "not-enabled.onion" ] &&
  [ "${APP_HIDDEN_SERVICE}" != "notyetset.onion" ]; then
  add "http://${APP_HIDDEN_SERVICE}"
fi

ALT="${ALT#,}"
export APP_DOOP_URL_ALT="${ALT}"
unset -f add
unset ALT
