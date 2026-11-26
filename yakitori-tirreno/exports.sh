# Umbrel sources this before the app's compose runs. Being sourced, it must not
# change shell options.
#
# tirreno builds absolute URLs (login redirects, email links, the ingest URL it
# prints on the dashboard) from SITE: a comma-separated host[:port] list with no
# protocol, whose FIRST entry wins. It never validates the request Host header,
# so a wrong value does not block access — it only makes redirects point at the
# wrong host.
#
#   APP_TIRRENO_SITE  canonical host[:port] for those URLs
#
# Umbrel has no variable for the remote (Tailscale or custom domain) hostname, so
# this defaults to the .local launch origin, which is right for LAN-and-app-proxy
# use. If you mostly open the dashboard over your tailnet, put that name first
# instead, e.g.
#
#   export APP_TIRRENO_SITE="umbrel.tailnet-xxxx.ts.net:8585"

PORT="${APP_PROXY_PORT:-8585}"
LOCAL_DOMAIN="${DEVICE_DOMAIN_NAME:-umbrel.local}"
APP_HIDDEN_SERVICE="${APP_HIDDEN_SERVICE:-}"

# A .onion address is the origin the user actually types when Tor access is on.
if [ -n "${APP_HIDDEN_SERVICE}" ] && [ "${APP_HIDDEN_SERVICE}" != "not-enabled.onion" ] &&
  [ "${APP_HIDDEN_SERVICE}" != "notyetset.onion" ]; then
  export APP_TIRRENO_SITE="${APP_HIDDEN_SERVICE}"
else
  export APP_TIRRENO_SITE="${LOCAL_DOMAIN}:${PORT}"
fi
