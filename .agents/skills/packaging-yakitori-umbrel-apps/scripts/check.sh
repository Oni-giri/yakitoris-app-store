#!/usr/bin/env bash
# Run the official umbrel-apps linter and this store's checker on one or more apps.
#
# Usage (from anywhere inside the store repo):
#   check.sh <app-id>... [--check-images] [--check-urls] [--base <git-ref>] [--format text|json]
#   check.sh --all [--check-images] [--check-urls]
#
#   --check-images  ask registries that every image is public and multi-arch (network)
#   --check-urls    fetch icon and gallery URLs (network)
#   --base REF      update-safety checks against REF (e.g. origin/master): version bumps,
#                   removed settings, DB major changes, new data dirs, changed secret labels
#
# Environment:
#   UMBREL_APPS_DIR  use this checkout of getumbrel/umbrel-apps instead of the cached clone
#   OFFLINE=1        do not clone/refresh the official repo (use the cache as-is)
#
# Exit status: 0 = no errors, 1 = errors found, 2 = usage/setup problem.
set -euo pipefail

SKILL_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STORE_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "${STORE_ROOT}" || ! -f "${STORE_ROOT}/umbrel-app-store.yml" ]]; then
  echo "check.sh: run this inside the app store repository (umbrel-app-store.yml not found)" >&2
  exit 2
fi

apps=()
official_args=()
checker_args=()
all=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --all) all=true; shift ;;
    --check-images) official_args+=(--check-images); shift ;;
    --check-urls) checker_args+=(--check-urls); shift ;;
    --base) [[ $# -ge 2 ]] || { echo "check.sh: --base needs a git ref" >&2; exit 2; }
            checker_args+=(--base "$2"); shift 2 ;;
    --format) [[ $# -ge 2 ]] || { echo "check.sh: --format needs a value" >&2; exit 2; }
              checker_args+=(--format "$2"); shift 2 ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "check.sh: unknown option $1" >&2; exit 2 ;;
    *) apps+=("${1%/}"); shift ;;
  esac
done
if [[ "${all}" != true && ${#apps[@]} -eq 0 ]]; then
  echo "check.sh: give app ids or --all (see --help)" >&2
  exit 2
fi

command -v node >/dev/null || { echo "check.sh: node (>= 20) is required" >&2; exit 2; }
command -v git >/dev/null || { echo "check.sh: git is required" >&2; exit 2; }

# 1. Checker dependency (yaml), installed next to the script on first use.
if [[ ! -d "${SKILL_SCRIPTS}/node_modules/yaml" ]]; then
  echo "check.sh: installing checker dependency (yaml) into ${SKILL_SCRIPTS}/node_modules" >&2
  # Retry with a throwaway npm cache when ~/.npm is unwritable (sandboxes, root-owned caches).
  npm install --prefix "${SKILL_SCRIPTS}" --no-audit --no-fund --silent >&2 2>/dev/null \
    || npm install --prefix "${SKILL_SCRIPTS}" --no-audit --no-fund --silent --cache "$(mktemp -d)" >&2 \
    || { echo "check.sh: npm install failed in ${SKILL_SCRIPTS}" >&2; exit 2; }
fi

# 2. Official umbrel-apps checkout: the official linter, and the port index of the official store.
OFFICIAL="${UMBREL_APPS_DIR:-${XDG_CACHE_HOME:-${HOME}/.cache}/yakitori-umbrel/umbrel-apps}"
if [[ -z "${UMBREL_APPS_DIR:-}" && "${OFFLINE:-0}" != 1 ]]; then
  if [[ -d "${OFFICIAL}/.git" ]]; then
    git -C "${OFFICIAL}" fetch --quiet --depth 1 origin HEAD \
      && git -C "${OFFICIAL}" reset --quiet --hard FETCH_HEAD \
      || echo "check.sh: could not refresh ${OFFICIAL}; using the cached copy" >&2
  else
    mkdir -p "$(dirname "${OFFICIAL}")"
    git clone --quiet --depth 1 https://github.com/getumbrel/umbrel-apps.git "${OFFICIAL}" \
      || { echo "check.sh: could not clone getumbrel/umbrel-apps (set UMBREL_APPS_DIR or OFFLINE=1)" >&2; exit 2; }
  fi
fi

official_json=""
if [[ -f "${OFFICIAL}/.tools/lint-apps.mjs" ]]; then
  if [[ ! -d "${OFFICIAL}/node_modules/yaml" ]]; then
    (cd "${OFFICIAL}" && { npm ci --ignore-scripts --no-audit --no-fund --silent 2>/dev/null \
      || npm ci --ignore-scripts --no-audit --no-fund --silent --cache "$(mktemp -d)"; } >&2) \
      || echo "check.sh: npm ci failed in ${OFFICIAL}; skipping the official linter" >&2
  fi
  if [[ -d "${OFFICIAL}/node_modules/yaml" ]]; then
    official_json="$(mktemp)"
    trap 'rm -f "${official_json}"' EXIT
    if [[ "${all}" == true ]]; then lint_targets=(--all); else lint_targets=("${apps[@]}"); fi
    # Exit status is ignored here: findings are merged and judged by check-app.mjs.
    (cd "${OFFICIAL}" && node .tools/lint-apps.mjs --root "${STORE_ROOT}" --format json \
      ${official_args[@]+"${official_args[@]}"} "${lint_targets[@]}" > "${official_json}" 2>/dev/null) || true
    if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "${official_json}" 2>/dev/null; then
      echo "check.sh: official linter produced no JSON; run it directly to see why:" >&2
      echo "  (cd ${OFFICIAL} && node .tools/lint-apps.mjs --root ${STORE_ROOT} ${apps[*]+"${apps[*]}"})" >&2
      official_json=""
    fi
  fi
else
  echo "check.sh: official linter not found in ${OFFICIAL}; only store checks will run" >&2
fi

# 3. Store checker (merges the official findings, applies yakitori-allow comments).
args=(--root "${STORE_ROOT}")
[[ -d "${OFFICIAL}" ]] && args+=(--official "${OFFICIAL}")
[[ -n "${official_json}" ]] && args+=(--official-lint "${official_json}")
[[ "${all}" == true ]] && args+=(--all)
# Not exec: the EXIT trap must still delete the temporary official-lint JSON.
status=0
node "${SKILL_SCRIPTS}/check-app.mjs" "${args[@]}" ${checker_args[@]+"${checker_args[@]}"} ${apps[@]+"${apps[@]}"} || status=$?
exit "${status}"
