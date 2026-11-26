#!/usr/bin/env bash
# Smoke-test one app package on a real umbrelOS device over SSH.
#
# Usage (from the store repo root):
#   device-test.sh <app-id> <ssh-target> [--update] [--host <name-or-ip>]
#     <ssh-target>  e.g. umbrel@umbrel.local (key auth recommended: ssh-copy-id)
#     --update      the app is already installed (at the shipped version): update it
#                   instead of installing. Install the shipped version first, create data.
#     --host        hostname/IP for the port probes from this machine (default: the ssh
#                   target without user@; set it when the target is an ssh alias)
#
# What it does:
#   1. rsyncs <app-id>/ over the device's clone of this store (strips .gitkeep like umbrelOS)
#   2. on the device, as root (one sudo prompt): install or update through umbreld,
#      wait for "ready", wait for the web container to answer on APP_HOST:APP_PORT,
#      restart through umbreld, check again, print container status/health and log tails
#   3. from this machine: probe http:// and https:// on the manifest port
#
# It does NOT replace the browser checklist in reference/testing.md.
# Exit status: 0 = all automated checks passed, 1 = a check failed, 2 = usage/setup error.
set -euo pipefail

usage() { sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2; }
[[ $# -ge 2 ]] || usage
APP_ID="${1%/}"; TARGET="$2"; shift 2
MODE=install
HOST=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --update) MODE=update ;;
    --host) [[ $# -ge 2 ]] || usage; HOST="$2"; shift ;;
    -h|--help) usage ;;
    *) echo "device-test.sh: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
[[ -f "${ROOT}/${APP_ID}/umbrel-app.yml" ]] || { echo "device-test.sh: ${ROOT}/${APP_ID}/umbrel-app.yml not found" >&2; exit 2; }
PORT="$(sed -n 's/^port:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "${ROOT}/${APP_ID}/umbrel-app.yml" | head -1)"
[[ -n "${PORT}" ]] || { echo "device-test.sh: could not read port from the manifest" >&2; exit 2; }
HOST="${HOST:-${TARGET#*@}}"

echo "==> Locating the store clone on ${TARGET}"
STORE_DIR="$(ssh "${TARGET}" 'ls -d "$HOME"/umbrel/app-stores/*yakitoris-app-store* 2>/dev/null' || true)"
if [[ -z "${STORE_DIR}" || "$(printf '%s\n' "${STORE_DIR}" | wc -l)" -ne 1 ]]; then
  echo "device-test.sh: expected exactly one ~/umbrel/app-stores/*yakitoris-app-store* on the device, got: '${STORE_DIR}'." >&2
  echo "Add https://github.com/Oni-giri/yakitoris-app-store as a Community App Store first." >&2
  exit 2
fi

echo "==> Syncing ${APP_ID}/ to ${STORE_DIR}/${APP_ID}/"
rsync -a --delete --exclude=.gitkeep "${ROOT}/${APP_ID}/" "${TARGET}:${STORE_DIR}/${APP_ID}/"

# Device-side part, run as root in a single sudo session.
REMOTE_SCRIPT="$(cat <<'REMOTE'
set -uo pipefail
APP_ID="$1"; MODE="$2"
fail=0
client() { umbreld client "$@"; }
state() { client apps.state.query --appId "${APP_ID}" 2>/dev/null | jq -r '.state // "unknown"'; }
wait_ready() {
  local deadline=$(( $(date +%s) + ${1:-1200} )) s=""
  while (( $(date +%s) < deadline )); do
    s="$(state)"
    case "${s}" in
      ready) echo "    state: ready"; return 0 ;;
      unknown|stopped|not-installed) echo "    state: ${s}"; return 1 ;;
    esac
    sleep 5
  done
  echo "    timed out in state: ${s}"; return 1
}
wait_web() {
  local cfg="/home/umbrel/umbrel/app-data/${APP_ID}/app-gateway.json" host port ip code deadline=$(( $(date +%s) + ${1:-600} ))
  if [[ ! -f "${cfg}" ]]; then echo "    no app-gateway.json (app without app_proxy): skipping upstream probe"; return 0; fi
  host="$(jq -r '.APP_HOST // empty' "${cfg}")"; port="$(jq -r '.APP_PORT // empty' "${cfg}")"
  while (( $(date +%s) < deadline )); do
    ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "${host}" 2>/dev/null | awk '{print $1}')"
    if [[ -n "${ip}" ]]; then
      code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "http://${ip}:${port}/" || true)"
      if [[ "${code}" =~ ^[1-4][0-9][0-9]$ ]]; then echo "    ${host}:${port} answered HTTP ${code}"; return 0; fi
    fi
    sleep 5
  done
  echo "    ${host}:${port} did not answer with a non-5xx response"; return 1
}

echo "==> umbrelOS $(cat /etc/os-release 2>/dev/null | sed -n 's/^VERSION=//p' | tr -d '"') on $(uname -m)"
echo "==> Registry entry"
client appStore.registry.query | jq -c --arg id "${APP_ID}" '[.[].apps[] | select(.id == $id) | {id, version, manifestVersion, compatible}]'
current="$(state)"
if [[ "${MODE}" == install ]]; then
  if [[ "${current}" != not-installed ]]; then echo "!! ${APP_ID} is already installed (${current}); uninstall it or use --update"; exit 1; fi
  echo "==> Installing"; client apps.install.mutate --appId "${APP_ID}" >/dev/null || fail=1
else
  if [[ "${current}" == not-installed ]]; then echo "!! ${APP_ID} is not installed; install the shipped version first"; exit 1; fi
  echo "==> Updating from installed version $(sed -n 's/^version: *//p' "/home/umbrel/umbrel/app-data/${APP_ID}/umbrel-app.yml")"
  available="$(client apps.updates.query | jq -r --arg id "${APP_ID}" '.[] | select(.id == $id) | .version')"
  if [[ -z "${available}" ]]; then echo "!! umbrelOS offers no update for ${APP_ID}: the synced manifest version equals the installed one. Bump version."; exit 1; fi
  echo "    updating to ${available}"
  client apps.update.mutate --appId "${APP_ID}" >/dev/null || fail=1
fi
wait_ready 1800 || fail=1
wait_web 900 || fail=1
echo "==> Restarting"
client apps.restart.mutate --appId "${APP_ID}" >/dev/null || fail=1
wait_ready 900 || fail=1
wait_web 900 || fail=1
echo "==> Containers"
docker ps -a --filter "label=com.docker.compose.project=${APP_ID}" --format '    {{.Names}}\t{{.Status}}'
if docker ps -a --filter "label=com.docker.compose.project=${APP_ID}" --format '{{.Status}}' | grep -Eq 'unhealthy|Restarting'; then
  echo "!! a container is unhealthy or restarting"; fail=1
fi
for c in $(docker ps -a --filter "label=com.docker.compose.project=${APP_ID}" --format '{{.Names}}'); do
  echo "==> Last 25 log lines: ${c}"
  docker logs --tail 25 "${c}" 2>&1 | sed 's/^/    /'
done
exit "${fail}"
REMOTE
)"

echo "==> Running lifecycle on the device (sudo may ask for the Umbrel password)"
remote_status=0
ssh -t "${TARGET}" "sudo bash -c $(printf '%q' "${REMOTE_SCRIPT}") device-test $(printf '%q' "${APP_ID}") ${MODE}" || remote_status=$?

echo "==> Probing the manifest port from this machine"
local_status=0
for scheme in http https; do
  code="$(curl -sk -o /dev/null -m 15 -w '%{http_code}' "${scheme}://${HOST}:${PORT}/" || true)"
  echo "    ${scheme}://${HOST}:${PORT}/ -> HTTP ${code}  (302 to :2000/app-auth means the gateway works and Umbrel login is required)"
  [[ "${code}" =~ ^[1-4][0-9][0-9]$ ]] || local_status=1
done

if [[ ${remote_status} -ne 0 || ${local_status} -ne 0 ]]; then
  echo "==> FAILED automated checks. Read the output above, fix, re-run."
  exit 1
fi
echo "==> Automated checks passed. Now do the browser checklist in reference/testing.md."
