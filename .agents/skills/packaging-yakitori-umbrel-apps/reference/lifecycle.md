# exports.sh, templates, hooks, and update migrations

## Contents
- exports.sh
- Templates
- Hooks
- Update-safe changes and migrations
- Version bump rules

## exports.sh

umbrelOS **sources** `exports.sh` inside its own bash process, with `set -euo pipefail` in effect. That happens on every install, start, update and compose call, and also when any app that depends on this one is sourced, and during image sweeps.

```sh
# Sourced by Umbrel before rendering templates and starting Compose. It must not
# change shell options, exit, cd, or leave helper variables behind.

export APP_EXAMPLE_DB_PASSWORD="$(derive_entropy "${app_entropy_identifier}-db-password")"
export APP_EXAMPLE_SESSION_SECRET="$(derive_entropy "${app_entropy_identifier}-session-secret")"

# Needs base64 of 32 bytes: decode the 64 hex chars to raw bytes, then base64.
_example_hex="$(derive_entropy "${app_entropy_identifier}-encryption-key")"
export APP_EXAMPLE_ENCRYPTION_KEY="$(printf "$(printf '%s' "${_example_hex}" | sed 's/../\\x&/g')" | base64 | tr -d '\n')"

# APP_PROXY_PORT is assigned after this file is sourced: keep the manifest port as a fallback.
_example_port="${APP_PROXY_PORT:-8790}"
_example_host="${DEVICE_DOMAIN_NAME:-umbrel.local}"
export APP_EXAMPLE_URL="https://${_example_host}:${_example_port}"
export APP_EXAMPLE_TRUSTED_PROXIES="${NETWORK_IP:-10.21.0.0}/16"

unset _example_hex _example_port _example_host
```

**Rules:**

- **What the file must not contain:**
  - a shebang or the executable bit
  - `set`, `exit`, `cd`, `trap` or `shopt`
  - functions left defined
  - side effects such as `mkdir`, `chown`, docker calls or network calls
- **Variables that do not exist yet** inside `exports.sh`: `APP_ID`, `APP_SEED`, `APP_PASSWORD`, `APP_PROXY_PORT`, `APP_VERSION`, `APP_DOMAIN` and `APP_HIDDEN_SERVICE`. Give every variable you read a default with `${VAR:-default}`, because an unset variable aborts the lifecycle.
  - The app script sources `exports.sh` several times per operation in the same shell. The first pass sees these variables unset; later passes see the values exported after the previous pass. So `${APP_HIDDEN_SERVICE:-}` usually holds the onion name by the time compose runs, but never rely on it in the first pass.
- **Path variables:**
  - Use `${EXPORTS_APP_DATA_DIR}` for this app's data and `${EXPORTS_APP_DIR}` for its other files.
  - Never use `${APP_DATA_DIR}`; it belongs to whichever app is being started, which can be a dependent app.
- **Naming:**
  - Exported names follow `APP_<ID_WITHOUT_YAKITORI, UPPER_SNAKE>_<PURPOSE>`, for example `APP_KEEPER_AUTH_SECRET`.
  - Prefix helpers with `_<app>_` and `unset` them at the end.
- **The last command must succeed.** Never end the file with `[[ ... ]] && export ...`, because a false test makes the file return non-zero and aborts. Use an `if` block.
- **Secrets:**
  - Use `derive_entropy` with one label per purpose: `"${app_entropy_identifier}-<purpose>"`.
  - The value is stable for the life of the device seed, survives reinstalls, and is restored with backups.
  - Never derive provider API keys, OAuth secrets or wallet seeds; users supply those through manifest `environment:`.
- **Keep labels fixed.** Changing a label changes the secret, which locks the app out of its own database or encrypted data.
- **Omit the file** when the package needs no computed values.

**Check the file locally:**

```bash
bash -n exports.sh
bash -c 'set -euo pipefail; derive_entropy(){ printf "%064d" 0; }; app_entropy_identifier=app-x-seed; EXPORTS_APP_DATA_DIR=/tmp/x; . ./exports.sh; env | grep ^APP_'
```

## Templates

- **What gets rendered.** Only `<app>/*.template` files at the top level are rendered, at install, every start, and update. Each one is rendered to the same name without `.template`, beside it in app data, and the output is overwritten every time.
- **Commit only the `.template`.** Never commit the rendered output.
- **Substitution is greedy.** Rendering uses `envsubst` with no variable list, so **every** `$NAME` or `${NAME}` matching an exported variable is replaced. Unknown ones become empty, as far as GNU envsubst goes. That makes templates a poor fit for shell scripts and nginx configs that have their own `$vars`.
  - For those, inline the config in compose with `$$` escaping instead.
- **Mounting the output.** Mount the rendered file from `${APP_DATA_DIR}/<name>` (outside `data/`), with `:ro`.

## Hooks

**Mechanics:**

- Valid names: `pre-install`, `post-install`, `pre-start`, `post-start`, `pre-stop`, `post-stop`, `pre-update`, `post-update`. Nothing else runs, including `pre-uninstall` and `post-uninstall`.
- Hooks run **as root on the host**, only if executable. Commit them with `git update-index --chmod=+x`, because the checker reads git's file mode.
- **Exit codes are ignored.** A hook cannot stop the lifecycle, so never hide required setup in one.
- Hooks may run up to 3 times per operation because of retries. **Make them idempotent.**
- During an update, `pre-update` is the **old** package's hook, and `post-update` is the new one.

**Default shape:**

```bash
#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DATA_DIR:-$(readlink -f "$(dirname "${BASH_SOURCE[0]}")/..")}"
DATA_DIR="${APP_DATA_ROOT:-${APP_DIR}/data}"

# Example: directory added in 1.5.0, existing installs need it before containers start.
if [[ ! -d "${DATA_DIR}/uploads" ]]; then
  mkdir -p "${DATA_DIR}/uploads"
  chown 1000:1000 "${DATA_DIR}/uploads"
fi
```

**When to use one.** Use hooks only for these:

- creating a new bind-mount directory on existing installs (`pre-start`)
- narrow ownership fixes or data migrations on existing installs (`pre-start`, guarded by a sentinel file)
- removing a file that an old version installed and that must stop being used (`pre-start` or `post-update`)

**Not for these:**

- directory scaffolding on new installs (commit `.gitkeep` instead)
- secrets (use `derive_entropy`)
- schema migrations (use a migrate service)
- downloading things
- anything with no timeout. A hung hook blocks the app forever.

**Data paths.** Write all data through `DATA_DIR` (`APP_DATA_ROOT`). `${APP_DATA_DIR}/data` is wrong once the user has moved data.

## Update-safe changes and migrations

On update, umbrelOS copies only `docker-compose.yml`, `exports.sh`, top-level `*.template`, `torrc`, `hooks/` and then `umbrel-app.yml`. Plan each kind of change:

| Change | What existing installs need |
|---|---|
| New bind mount directory | Commit `data/<dir>/.gitkeep` for fresh installs, plus a `pre-start` hook that creates and chowns it. umbreld also creates it, but as root. |
| Moved bind mount | A `pre-start` migration that moves old → new once (sentinel), never an empty replacement. |
| New config file | Inline it in compose, or make it a top-level `.template`. Never a new plain file. |
| Removed hook/template | Old copies linger. Neutralise their effect in a remaining hook if that matters. |
| Changed `exports.sh` secret label | Don't. The old secret is what the DB was initialised with. |
| Renamed service | Avoid. It drops users' `environment`/`folderAccess` choices and changes `<id>_<svc>_1`. |
| New required env var with a generated value | Add it to `exports.sh` (deterministic), not a hook-written file. |
| DB major version | Do not change it without a tested dump/restore or `pg_upgrade` path. |
| Added `storage.dataRoot` | Fine at any time. Removing it is never fine. |
| Port change | Change manifest `port` and every `exports.sh` fallback together. Users' bookmarks break, so mention it in releaseNotes. |

## Version bump rules

| Change | Bump `version`? |
|---|---|
| Image tag/digest, compose, exports.sh, hooks, templates, and manifest `port`, `storage`, `environment`, `folderAccess`, `requiresHttps`, `permissions`, `widgets`, `backupIgnore`, `dependencies`, `deterministicPassword`, `manifestVersion` | **Yes**: new upstream version, or `<upstream>-umbrel.N` |
| `description`, `tagline`, `icon`, `gallery`, `category`, README | No |

**Releasing the bump:**

- Bump at most once per release to `master`. If several fixes land between releases, they share one bump.
- Rewrite `releaseNotes` for the new version every time.
- Run `scripts/check.sh <id> --base origin/master`; it fails when runtime files changed but `version` did not.
