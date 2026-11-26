# What umbrelOS does with a package

This page describes umbreld behaviour as verified against the `getumbrel/umbrel` source at umbrelOS 2.1.0-beta.2, mostly under `packages/umbreld/source/modules/apps/`. If a newer umbrelOS behaves differently, trust the source and update this page. The lifecycle itself runs as a bash script, `legacy-compat/app-script`. Line numbers move between releases, so treat file names as pointers.

## Contents
- Store sync and registry
- Install
- Update
- Start, stop, restart, uninstall, boot
- Environment variables and when they exist
- Compose patching
- App settings (environment / folderAccess)
- Data root relocation
- Backups
- Widgets
- Silent failures

## Store sync and registry (`app-repository.ts`, `app-store.ts`)

- **Sync.** The store is shallow-cloned (`depth 1`) from the remote's **default branch** into `~/umbrel/app-stores/<owner>-<repo>-github-<sha256(url)[0:8]>/`.
  - umbreld checks every 5 minutes and re-clones the whole repo atomically whenever `HEAD` moves.
  - The clone is `chown -R 1000:1000`, and **every `.gitkeep` is deleted**.
- **Store metadata.** `umbrel-app-store.yml` (`id: yakitori`) must exist. Without it the whole store disappears from the registry, and the error is only logged.
- **Manifest discovery.** umbreld globs `*/umbrel-app.yml`, one level deep. Other top-level files and directories (`.github`, `.agents`, `README.md`) are ignored.
- **Apps that are skipped**, each with a log line only:
  - Unparseable YAML.
  - An invalid `storage` block.
  - `disabled: true`.
  - An `id` that does not start with `yakitori`.
  - A manifest that parses but has no `id` drops the **entire store**: the registry code throws on it, and the whole repository is skipped.
- **Schema validation is disabled.** Wrong field types pass and break the UI later. For example, a null `gallery` crashes the UI on `.map`.
- **The directory name must equal `id`.** Install resolves `<store>/<id>`. App IDs must match `^[a-zA-Z0-9-_]+$`, but the app-auth endpoint only accepts `^[a-zA-Z0-9-]+$`. **Do not use underscores.**
- **Duplicate IDs.** The first repository wins, and the official store is always first. The `yakitori-` prefix is what keeps our IDs from colliding.
- **Icon and gallery.** Community stores use `icon` and `gallery` verbatim. A missing `icon` falls back to `https://getumbrel.github.io/umbrel-apps-gallery/<id>/icon.svg`, which does not exist for our apps.
- **Update detection.** umbrelOS offers an update when the store `version` **is a string** and differs from the installed `version`, by any difference, not a semver comparison.
- **`manifestVersion`.** It is coerced to semver (`2.0` becomes `2.0.0`). Install and update refuse when it is greater than the OS release version; prereleases count as their release.

## Install

The install runs in this order:

1. `rsync --archive --exclude .gitkeep <store>/<id>/. ~/umbrel/app-data/<id>/`
   - This copies the **whole package directory**, owned 1000:1000 and keeping git modes.
   - There is no `--delete`, so leftovers from a failed install remain.
2. umbreld saves `settings.yml`, patches compose (see below), and writes `docker-compose.umbrel-user-settings.yml`.
3. umbreld pulls every literal `services.*.image` string. **A failed pull fails the install**, including an image containing `${...}`.
4. The script `install` step runs. It is retried up to 3 times in total, and every hook re-runs on each retry:
   1. `pre-install`
   2. source env
   3. render templates
   4. `compose pull`
   5. source env, render templates
   6. `pre-start`
   7. `docker compose up --detach --build`
   8. `post-start`
   9. `post-install`
5. The state becomes `ready` as soon as `up` returns. There is **no health wait**. The gateway route for the port appears only once a TCP connect to `APP_HOST:APP_PORT` succeeds; until then the port refuses connections.
6. **On failure, nothing is rolled back.** `app-data/<id>` stays, and so may containers.

## Update

`pre-patch-update` runs in this order:

1. Stop the app: `pre-stop` → `compose rm --force --stop` → `post-stop`.
2. Run the **old** `pre-update` hook.
3. Copy **only** `docker-compose.yml`, `*.template` (top level), `exports.sh`, `torrc` and `hooks/`. `hooks/` is merged, so deleted hooks and templates **linger**.
4. Source the new env and render templates.
5. Copy `umbrel-app.yml` **last**. If exports or templates fail, the old manifest stays.

After that, umbreld continues:

1. Patch compose.
2. Pull the images. **The download time counts as downtime**, because the app is already stopped.
3. `start`.
4. `post-patch-update`, which runs the **new** `post-update` hook.
5. Set auto-start to true, even if the user had stopped the app.

Two consequences:

- **No rollback.** A failed pull or start leaves the new files in place, the app stopped, and the state `unknown`. Because the manifest now matches the store, no update is offered again.
- **Files that never reach existing installs:** `data/` seed files, `.env.app_proxy`, and any other file or subdirectory.
- **Never ship `.env.app_proxy`.** The gateway merges it *over* the compose `app_proxy` environment, and it is frozen at first install.

## Start, stop, restart, uninstall, boot

- **Start.**
  1. Patch compose and regenerate the user-settings compose (this happens on **every start**).
  2. Source env and render templates.
  3. Wait up to 10 s for the Tor hidden service.
  4. `pre-start`, then `up --detach --build`, then `post-start`.
  
  The start is retried up to 3 times in total.
- **Stop.** `pre-stop` → `docker compose rm --force --stop` → `post-stop`. Compose's default stop timeout of 10 s applies unless a service sets `stop_grace_period`.
- **Restart.** Stop, then start.
- **Uninstall.**
  1. Stop.
  2. `down --remove-orphans`, without `-v`. **Named volumes survive.**
  3. Delete `app-data/<id>` and the moved data root.
  
  The `pre-uninstall` and `post-uninstall` hooks **never run**. The Tor hidden-service directory is kept.
- **Boot.** Every auto-start app starts **concurrently**, with no limit. Design startup to survive a slow Raspberry Pi with 20 other apps booting at the same time: long `start_period`s, retries, no hard startup deadlines.
- **No timeouts.** Script runs have none, so a hanging hook or entrypoint blocks the lifecycle forever.
- **Image sweep.** It runs after install, update and uninstall, and 10 minutes after boot. It deletes every image that no installed app's compose references. Images an app pulls itself at runtime get deleted while unused.

## Environment variables and when they exist

**Exported before hooks, exports.sh and compose:**

- `APP_DATA_DIR=~/umbrel/app-data/<id>`
- `APP_DATA_ROOT` (the current data folder)
- umbreld's own process environment
- `NETWORK_IP=10.21.0.0`, `GATEWAY_IP=10.21.0.1`
- `TOR_PROXY_IP=10.21.21.11`, `TOR_PROXY_PORT=9050`
- `REMOTE_TOR_ACCESS`, `BITCOIN_NETWORK=mainnet`

**Inside `source_app`, in order:**

1. `DEVICE_HOSTNAME` and `DEVICE_DOMAIN_NAME` (`<hostname>.local`) are exported.
2. `exports.sh` is sourced for each dependency first, then for this app. Inside it, these shell variables exist but are not exported:
   - `EXPORTS_APP_ID`, `EXPORTS_APP_DIR`, `EXPORTS_APP_DATA_DIR`, `EXPORTS_TOR_DATA_DIR`
   - `app_entropy_identifier` (`app-<id>-seed`)
   - the `derive_entropy <label>` function, which returns the HMAC-SHA256 hex (64 chars) of the label keyed by the device seed
3. Then these are exported, **after** `exports.sh`, so they are unavailable inside it, and an `exports.sh` cannot override them:
   - `APP_ID`, `APP_MANIFEST_FILE`, `APP_VERSION`
   - `APP_PROXY_PORT` (the manifest `port`)
   - `APP_DOMAIN` (`<hostname>.local`)
   - `APP_HIDDEN_SERVICE` (`not-enabled.onion` or `notyetset.onion` until Tor creates it)
   - `APP_SEED`, `APP_PASSWORD`
   - `TOR_*`, `UMBREL_ROOT`

**Who sees what:**

- **`pre-install`, `pre-stop`, `pre-update`** see only the first group.
- **`pre-start`, `post-start`, `post-install`, `post-update`** see everything.
- **Compose interpolation and `envsubst` templates** see everything that is exported. Exports from `exports.sh` are visible to compose.
- **Dependent apps.** `exports.sh` is also sourced for apps that depend on this one, and during image sweeps. There, `APP_DATA_DIR` belongs to the *dependent* app, so use `EXPORTS_*` instead.

The script runs with `set -euo pipefail`. In a sourced `exports.sh`, an unset variable or a failing last command aborts install, start or update.

## Compose patching (`app.ts` `patchComposeFile`, `app-script` `compose()`)

**Rewrites at every install, start, restart and update.** The YAML is re-dumped, so comments are lost on the device:

- Every service gets `container_name: <id>_<service>_1` unless it sets its own. This name is the DNS name on `umbrel_main_network`.
- Volume sources are rewritten:
  - `/data/storage/downloads` becomes `/home/Downloads`, and `/data/storage` becomes `/home`. This is an **unanchored substring replace on every source**, so never name an app directory `storage` directly under a `data` directory.
  - With `storage.dataRoot: data`, `${APP_DATA_DIR}/data[/…]` (only that exact spelling, or `$APP_DATA_DIR/data`) becomes `${APP_DATA_ROOT}[/…]` with `create_host_path: false`.
  - On those redirected `data/` binds, only `ro`, `rw`, `z`/`Z`, propagation flags and consistency flags are allowed. **Any other option fails the start.**
- `/dev/dri` entries in `devices:` are removed unconditionally. Declare `permissions: [GPU]` instead, and umbreld injects GPU devices for every service.

**At runtime:**

- Compose runs as `docker compose --project-name <id> [-f tor.yml] -f common.yml -f <app compose> [-f user-settings.yml]`.
  - `common.yml` makes the `default` network the external `umbrel_main_network` (10.21.0.0/16), which **every app** joins.
  - The first `-f` lives in umbreld's own directory, so relative paths (`./x`, `build: .`, `env_file: .env`) resolve there, not in the app folder. Always use `${APP_DATA_DIR}/...`.
  - The `.env` file is not loaded.
- If `services.app_proxy` exists:
  1. umbreld renders the compose config, which also validates the whole file.
  2. It extracts `APP_HOST`, `APP_PORT`, `APP_PROTOCOL`, `PROXY_AUTH_ADD`, `PROXY_AUTH_WHITELIST`, `PROXY_AUTH_BLACKLIST`, `PROXY_TRUST_UPSTREAM` and `PROXY_TIMEOUT` into `app-gateway.json`.
  3. It runs `compose up` on a copy with `app_proxy` **deleted**. Anything that references `app_proxy` breaks.
- Without `app_proxy`, the app needs one of the following, or it gets **no route**:
  - a service publishing `ports: ["<manifest port>:<container port>"]` that serves plain HTTP, or
  - `network_mode: host`.
- Start flags: `up --detach --build`, with the default pull policy `missing`, no `--remove-orphans`, and no `--wait`.

## App settings (environment / folderAccess)

- **Storage of saved values.** Values go to `app-data/<id>/settings.yml`, and umbreld renders them into `docker-compose.umbrel-user-settings.yml`, which is merged last.
  - `$` is escaped, so values are literal.
  - A changed value triggers an app restart.
- **`environment:` entries are silently dropped** when:
  - the `name` is not `^[A-Za-z_][A-Za-z0-9_]*$`,
  - the name is duplicated,
  - any listed service is missing, or the service is `app_proxy`.
- **`default` is only a UI placeholder.** Set the real default in compose. `options` restricts the values a user can save.
- **`folderAccess` entries are silently dropped** for any of these:
  - an unknown service
  - a non-absolute target, or `/`
  - a duplicate `id`, or a duplicate `service:targetPath`
  - `service` omitted while there is more than one non-proxy service
- **Folder sources** are `/Home`, `/External/<drive>` or `/Network/<host>/<share>`. A missing source folder **fails the start**.
- **Stability.** Keep service names, `environment[].name` and `folderAccess[].id` stable across updates; renamed entries drop the user's saved choices.

## Data root relocation (`storage.dataRoot: data`)

- **Where it can move.** Users can move `data/` to an ext4 external drive. Only `data/` moves; everything else under `APP_DATA_DIR` stays behind.
- **Directories created on every lifecycle step.** Before every install, start, update or restart, umbreld runs `mkdir -p` as root on every `${APP_DATA_ROOT}/<x>` bind source:
  - A **file** mount there fails with EEXIST.
  - A missing source becomes a root-owned directory.
- **Use the right variable for each file:**
  - Compose: `${APP_DATA_DIR}/data/...`, which umbreld rewrites.
  - Hooks: `${APP_DATA_ROOT}`.
  - `exports.sh`: `${EXPORTS_APP_DATA_DIR}`.
  - A hook that writes `${APP_DATA_DIR}/data/...` writes to the old location after a move.
- **Removing `storage` in an update** makes the app unstartable for users who moved its data.
- **Backups skip moved data** (see Backups).

## Backups

- **Snapshots are live.** Backups are Kopia snapshots of the whole Umbrel data directory, taken **while apps run**, with no stop and no dump hook. Files are read one after another, not as one atomic snapshot, so a running database's files may be restored inconsistent with each other. Postgres usually recovers through WAL replay, but nothing guarantees it. For high-value databases, consider a scheduled dump (for example `pg_dump` from a sidecar into `data/backups/`) that a restore can fall back on.
- **`backupIgnore:`.** Paths are relative to `APP_DATA_DIR`, using only `[-a-zA-Z0-9._/*]`. Use it for caches, indexes and regenerable downloads, never for primary data.
- **Restore.** Restoring reinstalls any app the user excluded from backup, with fresh data.
- **Moved data is not backed up.** `/External` and `/Network` are always excluded, so an app whose data root the user moved to an external drive has **no backup of `data/`**. Mention this in the description of apps whose data matters.

## Widgets

- **Endpoint.** The `endpoint` is `service:port/path`, where `service` is a compose service key. It is fetched server-side over plain HTTP with no auth and **no timeout**.
- **Response.** The JSON must include `refresh` (for example `"30s"`).
- **Limits.** A user can enable at most 3 widgets.
- **Host-network services** cannot serve widgets, and neither can services attached to more than one network: umbreld concatenates their IPs into a broken URL.

## Silent failures

- Hook exit codes are ignored (`|| true`). Hooks run only if they are executable.
- Invalid manifests vanish from the store.
- Invalid `environment` and `folderAccess` entries vanish from settings.
- A second app with the same manifest port gets no route; the app installed first wins. The only trace is the log line `Skipping LAN ingress route for <id>; port <n> is already used`.
- An update with no `version` change is invisible to installed devices.
