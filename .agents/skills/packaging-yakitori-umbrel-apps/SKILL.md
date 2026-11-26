---
name: packaging-yakitori-umbrel-apps
description: Packages, updates, fixes, and reviews umbrelOS apps for Yakitori's community app store (github.com/Oni-giri/yakitoris-app-store, app IDs `yakitori-*`). Covers umbrel-app.yml, docker-compose.yml, exports.sh, hooks, multi-arch image pinning, app gateway auth and HTTPS, persistence and data roots, update safety, and on-device testing, with a store-specific checker script. Use when adding an app to this store, bumping or fixing a yakitori-* package, auditing packages, or editing the store's update workflows.
---

# Packaging Yakitori Umbrel apps

umbrelOS checks this repo's default branch every 5 minutes and re-clones it when it has moved. **A push to `master` ships to every device.**

umbrelOS validates almost nothing, so mistakes fail silently:

- A broken manifest just disappears from the store.
- Hook failures are ignored.
- A compose change with no version bump never reaches existing installs.

Correctness therefore comes from the rules, scripts and tests below, not from the platform.

The official Umbrel packaging rules still apply. This skill adds three things on top of them:

- how community stores differ from the official store
- what umbreld actually does at runtime
- what has already broken in this repo

Links in this file are relative to this skill's directory. Run the commands from the repository root.

## Pick the workflow

- **New app** → follow [New package](#new-package).
- **Upstream version bump or package fix** → follow [Update](#update).
- **Review or audit** → run `.agents/skills/packaging-yakitori-umbrel-apps/scripts/check.sh --all --check-images`, then read [reference/pitfalls.md](reference/pitfalls.md) and check every rule below by hand.
- **Editing `.github/workflows/update-*.yml`** → read the "Automation" section of [reference/pitfalls.md](reference/pitfalls.md) first.

## Hard rules

Every rule here has broken a real package. The checker enforces the rules marked ✔. Verify the rest by reading the package.

**Identity and metadata**

1. ✔ `id` must equal the directory name and be `yakitori-<slug>`: lowercase kebab-case, no underscores. umbrelOS silently drops apps whose id lacks the store prefix, and its login handoff rejects `_`. Never rename a released id, because the id is the data path.
2. ✔ Quote `version: "1.2.3"`. An unquoted `1.2` is a YAML number, and umbrelOS then never offers the update.
3. ✔ `icon` must be an absolute `https://` URL. Without one, umbrelOS falls back to the *official* store's icon URL for this id, which does not exist.
   - `gallery` must hold absolute URLs, or be `[]`.
   - Never leave `gallery`, `releaseNotes` or `dependencies` null; the store UI crashes on null.
4. ✔ `port` must be unique across this store **and** the official store. Never use 80, 443 or 2000, and stay out of 40000–49999 (reserved for VMs).

**Images**

5. ✔ Write every image as `registry/repo:<release-tag>@sha256:<multi-arch index digest>`.
   - The index must cover both `linux/amd64` and `linux/arm64`.
   - The reference must be a literal, with no `${...}`, because umbreld pulls images from the raw YAML before it interpolates anything.
   - Do not use `build:`.
   - Get the reference from `scripts/resolve-image.mjs`; never copy a digest by hand.

**Networking and the app gateway**

6. ✔ Reach sibling services as `<app-id>_<service>_1` (for example `yakitori-foo_db_1`), never by a bare service name. Every app shares `umbrel_main_network`, so `db`, `postgres`, `redis`, `mcp` or `sync` resolve round-robin into **other apps' containers**.
7. ✔ `app_proxy` holds environment configuration only. umbreld deletes it before running `compose up`, so no other service may reference it (`depends_on`, links, URLs).
8. Umbrel login stays on.
   - Whitelist only machine-to-machine paths, such as API-token APIs, MCP, webhooks and OAuth token endpoints.
   - Write each one as the exact path **and** `/path/*`, because `/x/*` does not match `/x`.
   - Before shipping, prove that nothing under a whitelisted prefix allows sign-up, admin bootstrap, or data access without the app's own auth. See [reference/gateway.md](reference/gateway.md).

**Persistence**

9. ✔ Durable state goes only in bind mounts of **directories** under `${APP_DATA_DIR}/data/...`.
   - Commit each source directory with a `.gitkeep`.
   - Declare `storage: {dataRoot: data}`, and never remove it later.
   - Do not use named volumes.
   - Do not keep durable files outside `data/`.
   - Do not mount single files under `data/`; umbreld runs `mkdir -p` on every source there.
10. ✔ On update, umbrelOS copies only `docker-compose.yml`, `exports.sh`, top-level `*.template`, `torrc`, `hooks/` and `umbrel-app.yml`. Any other package file (`nginx.conf`, `server.js`, `config/...`) is **frozen at first install**.
    - Inline config in compose instead. Escape `$` as `$$`.
    - Or render it from a top-level `.template`.

**Secrets and runtime environment**

11. ✔ Generate secrets in `exports.sh` with `derive_entropy "${app_entropy_identifier}-<purpose>"`, one label per purpose.
    - Never use `openssl rand` in hooks, hardcoded passwords, or a well-known default admin login.
    - Password-protect every database and cache, because the shared network is untrusted.
12. ✔ `exports.sh` is *sourced* under `set -euo pipefail`, before `APP_ID`, `APP_SEED`, `APP_PASSWORD` and `APP_PROXY_PORT` exist.
    - Default every variable you use, for example `${APP_PROXY_PORT:-8792}` and `${NETWORK_IP:-10.21.0.0}`.
    - No shebang, no `set`, `exit` or `cd`, and no side effects.
    - `unset` your helper variables at the end.
13. ✔ Hooks run as root on the host. Their failures are ignored, and they may run up to 3 times.
    - Make them idempotent.
    - Write data paths through `${APP_DATA_ROOT}`.
    - The file mode must be executable in git.
    - `pre-uninstall` and `post-uninstall` never run.
14. Derive browser-facing URLs and trusted origins from `${DEVICE_DOMAIN_NAME}` and `${APP_PROXY_PORT:-<port>}`, and let users override them through manifest `environment:`.
    - The same port serves both `http://` and `https://`.
    - Users also arrive by IP address, Tailscale or `.onion`.
    - Never hardcode `umbrel.local`.

**Health and startup**

15. ✔ Give every service that others wait on a healthcheck that probes `127.0.0.1`, not `localhost`.
    - Gate dependent services with `condition: service_healthy` or `condition: service_completed_successfully`.
    - Use `restart: on-failure`.

**Shipping changes**

16. ✔ Any change an installed app needs must bump `version` and update `releaseNotes`. That covers compose, exports, hooks, templates, and the manifest fields umbrelOS reads from the installed copy: `port`, `storage`, `environment`, `folderAccess`, `requiresHttps`, `permissions`, `widgets`, `backupIgnore`, `dependencies` and `deterministicPassword`. The full table is in [reference/lifecycle.md](reference/lifecycle.md).
    - Use the new upstream version when there is one.
    - For package-only changes to the same upstream version, use `<upstream>-umbrel.N` (`1.4.2-umbrel.1`, then `-umbrel.2`, ...). This is the store convention.
17. ✔ Do not use `docker.sock`, `privileged`, host networking, devices or extra capabilities unless the product cannot work without them.
    - When you need one, acknowledge it in the file with `# yakitori-allow: <rule> <reason>`.
    - Disclose it in the manifest `description` as well.

## New package

Copy this checklist into your reply and tick items off as you go:

```
New package: yakitori-<slug>
- [ ] 1. Upstream discovery: license, latest stable release, Docker docs, service topology, first-run flow
- [ ] 2. Gate: browser UI, amd64+arm64 images, no host-root access needed
- [ ] 3. Pick port (scripts/check.sh reports collisions) and copy templates/
- [ ] 4. Pin every image with scripts/resolve-image.mjs
- [ ] 5. Write compose: unique hostnames, data/ mounts, healthchecks, secrets
- [ ] 6. Write exports.sh: derive_entropy secrets, canonical URL with defaults
- [ ] 7. Write manifest: icon URL, quoted version, description with setup notes
- [ ] 8. Auth review: whitelist audit (reference/gateway.md)
- [ ] 9. scripts/check.sh yakitori-<slug> --check-images → zero errors
- [ ] 10. Device test (reference/testing.md): install, open http+https, real workflow, restart, persistence
- [ ] 11. Update README.md table; commit
```

**Step 1: discovery.** Read the upstream self-hosting docs and example compose file at the exact release you will package. Then write down:

- every long-running process
- the internal port of each process
- every path the app writes to
- every secret it needs
- how the first admin account gets created
- which URL or origin settings it reads (`BASE_URL`, `ORIGIN`, `TRUSTED_ORIGINS`, ...)

**Step 2: gate.** Stop and tell the user if any of these hold:

- the app has no browser UI
- it ships only amd64 images
- it needs `docker.sock`
- it needs a fixed public domain before the local UI works

Wrapper images under `ghcr.io/oni-giri/` are allowed, but only as multi-arch images built in CI.

**Steps 3–7: write the files.** Copy `templates/umbrel-app.yml`, `templates/docker-compose.yml` and `templates/exports.sh` into `yakitori-<slug>/`. They follow this store's current style and pass the checker as they are. Then:

- Rename every `example` / `EXAMPLE` occurrence.
- Replace the zero digests with real ones.
- Delete whatever the app doesn't need.
- Create `data/<dir>/.gitkeep` for every bind mount.

`templates/hooks/pre-start` is only for updates that add a data directory.

Read these references as you go:

- [reference/manifest.md](reference/manifest.md) for every manifest field
- [reference/compose.md](reference/compose.md) for services, persistence, users and images
- [reference/lifecycle.md](reference/lifecycle.md) for `exports.sh`, templates and hooks
- [reference/gateway.md](reference/gateway.md) for auth, HTTPS, origins and MCP endpoints

New packages use:

- `manifestVersion: 2.0`
- `storage.dataRoot: data`
- `releaseNotes` along the lines of "Initial Umbrel package of <App> <version> (amd64 and arm64)…"

Start `docker-compose.yml` with a numbered header comment that lists every adaptation from upstream and why.

## Update

```
Update: yakitori-<slug> <old> → <new>
- [ ] 1. Read upstream release notes / upgrade guide for every version since <old>, not just the latest
- [ ] 2. Diff upstream compose/env examples between the two tags
- [ ] 3. Re-pin every changed image with scripts/resolve-image.mjs
- [ ] 4. Carry required env/compose changes; keep service names, folderAccess ids, environment names
- [ ] 5. New data dirs: commit .gitkeep AND add an idempotent pre-start hook to create them on existing installs
- [ ] 6. Bump version (upstream version or <upstream>-umbrel.N) and rewrite releaseNotes for upgraders
- [ ] 7. scripts/check.sh yakitori-<slug> --check-images --base origin/master → zero errors
- [ ] 8. Device test the update path from the currently shipped version (reference/testing.md)
```

Users skip versions. If an intermediate release has a required migration checkpoint, such as a database major-version upgrade or a mandatory stepping-stone version, handle it in the package or refuse the jump.

A database major-version bump, for example Postgres 16 → 17, is **not** a tag change: the existing data directory will not start. Leave the database version unchanged unless the package migrates the data.

## Validate

Run the checker from the repository root:

```bash
.agents/skills/packaging-yakitori-umbrel-apps/scripts/check.sh <app-id> [--check-images] [--check-urls] [--base <git-ref>]
.agents/skills/packaging-yakitori-umbrel-apps/scripts/check.sh --all
```

`check.sh` does three things:

1. Installs the checker's one dependency (`yaml`) on first run.
2. Clones or refreshes the official `getumbrel/umbrel-apps` repository into a cache directory.
3. Runs two checks on the app:
   - the official linter, with `--root` pointed at this repo
   - `check-app.mjs`, which covers the store-specific rules above, port collisions with the official store, and, with `--base`, whether `version` was bumped

Official findings appear with an `official:` prefix. The checker already drops the ones that are expected differences for a community store: `manifest.icon`, `manifest.gallery`, `package.review_assets`, the new-app `manifest.release_notes` error, `app.top_level` and `lint.infrastructure`.

Fix every error, run the checker again, and repeat until it reports no errors. Read every warning, and either fix it or be ready to explain it.

A deliberate exception is allowed only for host access (`access.*`), a genuinely single-architecture image (`image.architecture`), an image with no versioned tag (`image.latest`), a one-shot service that must not restart (`service.restart`), or an isolated internal network (`compose.networks`). The checker refuses `yakitori-allow` for anything else. Add a comment in the file, with a reason of at least three words:

```yaml
# yakitori-allow: access.privileged isolated Docker-in-Docker runner, socket stays inside data/
```

The checker then reports that finding as `allowed` instead of an error. Disclose the same exception in the manifest `description`.

**Running the checker runs package code.** It sources `exports.sh` the way umbrelOS does, with a minimal environment and a stub `derive_entropy`. That is not a sandbox: the code runs with your permissions, so only run the checker on packages you are willing to execute.

Never use `check-app.mjs` on its own: `check.sh` is what runs the official linter and the port index.

Resolve an image pin:

```bash
node .agents/skills/packaging-yakitori-umbrel-apps/scripts/resolve-image.mjs ghcr.io/owner/app:1.2.3
# prints: ghcr.io/owner/app:1.2.3@sha256:...  (fails if amd64 or arm64 is missing)
```

## Test on a device

Lint is not proof. Before telling the user a package works, install it through umbrelOS and check that it:

1. opens over `http://` and `https://`
2. completes a real workflow
3. still has its state after a restart
4. for an update, upgrades from the shipped version with its data intact

Use `scripts/device-test.sh <app-id> <ssh-target>`; [reference/testing.md](reference/testing.md) covers the details.

If there is no device, say exactly what was not runtime-tested.

## Commit

- **One app per commit.** Message: `yakitori-<slug>: add <App> <version> app package`, `yakitori-<slug>: update to <version>`, or `yakitori-<slug>: <fix>`.
- **Commit identity:** configure the repository-local identity before committing:

  ```bash
  git config user.name "yakitori"
  git config user.email "89288375+Oni-giri@users.noreply.github.com"
  ```

- **Never commit** rendered templates, runtime data, `.env` files or secrets.
- **README.md:** update the "Included Apps" table, including the Port and Arch columns.
- **Removing an app** strands existing installs. Record the reason in the commit message.

## Reference files

| File | Read when |
|---|---|
| [reference/platform.md](reference/platform.md) | You need to know exactly what umbrelOS does at install, update, start or stop, and when each variable exists |
| [reference/manifest.md](reference/manifest.md) | Writing or changing `umbrel-app.yml` |
| [reference/compose.md](reference/compose.md) | Writing services, volumes, users, healthchecks or images |
| [reference/gateway.md](reference/gateway.md) | Auth whitelists, HTTPS, origins, cookies, MCP/OAuth endpoints, WebSockets, timeouts |
| [reference/lifecycle.md](reference/lifecycle.md) | Writing `exports.sh`, templates, hooks or update migrations |
| [reference/testing.md](reference/testing.md) | Testing on an umbrelOS device |
| [reference/pitfalls.md](reference/pitfalls.md) | Reviewing a package; editing the update workflows |
