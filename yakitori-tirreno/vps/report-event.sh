#!/bin/sh
# Report one event to tirreno from a remote host over Tailscale.
#
# Install on the VPS, then:
#   export TIRRENO_URL="http://umbrel.tailnet-xxxx.ts.net:8585"
#   export TIRRENO_KEY="<api key from the tirreno dashboard>"
#   ./report-event.sh alice 203.0.113.50 /login account_login
#
# Arguments: <userName> <ipAddress> <url> [eventType] [httpCode]
# Exit codes: 0 accepted, 1 rejected by tirreno, 2 transport error, 64 usage.

set -eu

TIRRENO_URL="${TIRRENO_URL:?set TIRRENO_URL, e.g. http://umbrel.tailnet-xxxx.ts.net:8585}"
TIRRENO_KEY="${TIRRENO_KEY:?set TIRRENO_KEY to an API key from the dashboard}"

if [ "$#" -lt 3 ]; then
    echo "usage: $0 <userName> <ipAddress> <url> [eventType] [httpCode]" >&2
    exit 64
fi

user_name="$1"
ip_address="$2"
url="$3"
event_type="${4:-page_view}"
http_code="${5:-200}"

# tirreno accepts `Y-m-d H:i:s.v`; anything unparseable is replaced with now.
event_time=$(date -u +"%Y-%m-%d %H:%M:%S.000")

body=$(curl -sS -o /dev/null -w '%{http_code}' \
    -X POST "${TIRRENO_URL%/}/sensor/" \
    -H "Api-Key: ${TIRRENO_KEY}" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "userName=${user_name}" \
    --data-urlencode "ipAddress=${ip_address}" \
    --data-urlencode "url=${url}" \
    --data-urlencode "eventTime=${event_time}" \
    --data-urlencode "eventType=${event_type}" \
    --data-urlencode "httpCode=${http_code}" \
    2>/dev/null) || { echo "transport error reaching ${TIRRENO_URL}" >&2; exit 2; }

# 204 = accepted. 200 with an empty body = rejected (unknown key or missing
# required field, reason lands in the server's error log). 429 = rate limited.
case "$body" in
    204) exit 0 ;;
    429) echo "rate limited (default 10 req/s per API key)" >&2; exit 1 ;;
    200) echo "rejected: unknown Api-Key or missing required field" >&2; exit 1 ;;
    *)   echo "unexpected HTTP ${body}" >&2; exit 1 ;;
esac
