# Pitfalls: what has already broken in this store

Each entry is one real failure in this repository: what broke, why, and the rule that prevents it. Use the list as a review checklist. The checker catches the entries marked ✔.

## Contents
- Networking and hostnames
- Persistence and file ownership
- Updates that never reached devices
- URLs, origins, proxies
- Auth bypasses
- Startup and health
- Manifest and metadata
- Automation (update workflows)
- Review checklist

## Networking and hostnames

- ✔ **A bare `db` or `postgres` hostname hit other apps' databases.** The symptoms were intermittent `password authentication failed for user …` errors and 500s. This happened in ReviewBoard, MailFlow, Journiv and tirreno, and came back in ARTEX after a refactor.
  - Docker DNS on `umbrel_main_network` round-robins a short name across every app that has a service with that name.
  - **Rule:** always use `<id>_<service>_1`.
- **nginx `proxy_set_header Host $host` dropped the port**, so Django's CSRF origin check failed. **Rule:** use `$http_host`, written `$$http_host` in compose.
- ✔ **An invented gateway key, `PROXY_TRUST_PROXY`, was silently ignored.** **Rule:** use only the keys listed in gateway.md.
- ✔ **`APP_PORT: 8888:3088`** was invalid. **Rule:** `APP_PORT` is a single container port.

## Persistence and file ownership

- ✔ **Missing bind sources were created by Docker as `root:root`**, so non-root apps (Journiv) crashed on write. **Rule:** commit `data/<dir>/.gitkeep`.
- **Official Postgres forced to `user: 1000` failed `initdb`**, and `depends_on: service_healthy` then never resolved (tirreno). **Rule:** never set `user:` on database images. Use an init chown service for images with a fixed uid.
- ✔ **Durable data was kept outside `data/` while `storage.dataRoot` was declared** (Doop `postgres/` and `secrets/`, tirreno `secrets/`). Moving the data root leaves those files behind. **Rule:** everything durable lives in `data/`.
- ✔ **`build: ./image` resolved against umbreld's directory** and the install failed. Building on the device was also slow. **Rule:** use prebuilt multi-arch images only.

## Updates that never reached devices

- ✔ **Fixes committed without a version bump:**
  - DailyHub's `/mcp/*` security fix
  - a lint-fix sweep that changed restart policies and exports
  - Doop's re-pinned digest for the same version
  
  Installed devices never received them. **Rule:** any runtime change gets a version bump (`-umbrel.N`).
- ✔ **Config bind-mounted from package files was frozen at first install** (Nogon's nginx templates, itsaplan, Chartbrew's `web/server.cjs`, BrowserPier's AppArmor profile). Updates copy only compose, `exports.sh`, top-level templates, `torrc`, `hooks/` and the manifest. **Rule:** inline the config in compose, or generate it from a template or hook.
- **A marker substring in an entrypoint never matched**, so config was appended on every restart. **Rule:** run entrypoint logic and hooks twice when testing.

## URLs, origins, proxies

- **A hardcoded `http://umbrel.local` origin broke sign-in over Tailscale or IP.** A fix then misread `APP_DOMAIN` as a remote hostname; it is `<hostname>.local`. The same three fixes were needed again in Open Design. **Rule:**
  - Build the origin from `DEVICE_DOMAIN_NAME` and the port.
  - Trust both http and https.
  - Expose a manifest `environment:` override.
- **Server-built absolute URLs pointed at `umbrel.local`.** **Rule:** prefer request-relative URLs, or derive them per request from `Host` / `X-Forwarded-*`.
- ✔ **A value derived from an unguarded variable broke the app** (`${NETWORK_IP}/16`). Under umbrelOS's `set -u`, any unset variable aborts install and start outright. **Rule:** give every variable read in `exports.sh` a default; the checker sources the file the way umbrelOS does and reports variables that are not set yet.
- **An image's bundled Caddy overwrote `X-Forwarded-Proto` with `http`**, so MCP OAuth audiences were advertised as `http://` (Keeper). **Rule:** point `APP_HOST` at the app server, or make the internal proxy pass the header through.

## Auth bypasses

- **`/mcp/*` was whitelisted.** Next.js served its 404 handler there, and that handler executes Server Actions. The result was unauthenticated read/write/delete of all data (DailyHub). **Rule:** whitelist exact paths, and audit what the framework serves under a wildcard.
- **Broad `/api/*` whitelists** (Infisical, itsaplan, Chartbrew, Doop `/api/auth/*`) may expose first-account-becomes-admin sign-up on the LAN. **Rule:** run the whitelist audit in gateway.md. Narrow the whitelist with an nginx router or a `PROXY_AUTH_BLACKLIST`.
- ✔ **A hardcoded admin password** (`ADMIN_PASSWORD: may`), and a well-known upstream default admin login (Oxynote). **Rule:** `${APP_PASSWORD}` + `deterministicPassword: true`, or browser sign-up.
- ✔ **Passwordless Redis/Valkey on the shared network** (Infisical, GlitchTip). **Rule:** `--requirepass` with a derived secret.

## Startup and health

- **A single `pg_isready` probe passed during first-boot initdb**, so the app migrated against a half-ready database. **Rule:**
  - Probe over TCP: `-h 127.0.0.1`.
  - Use `start_period` and `retries`.
  - Gate with `service_healthy`.
- ✔ **A healthcheck against `localhost` failed** (IPv6 / busybox). **Rule:** use `127.0.0.1`.
- ✔ **Services were started with no healthcheck and only `condition: service_started`** (Anki, Act-CI, ARTEX). They crash-loop on a slow first boot. **Rule:** use healthchecks and health conditions.

## Manifest and metadata

- ✔ **`gallery:`, `releaseNotes:` or `dependencies:` left null crashed the store UI.** **Rule:** use `[]` / `""`.
- ✔ **An id without the store prefix was silently dropped from the store** (mailflow); a rename then left `APP_HOST` and DSNs on the old id. **Rule:** `id` = directory = `yakitori-*`. After any rename, grep for the old id.
- ✔ **Misnamed files** (`docker-compose.yaml`, `export.sh`). **Rule:** use the exact file names.
- **A webp icon, then an SVG with masks, rendered badly.** Icons are cached by URL. **Rule:** use a flat SVG or PNG, and change the URL when you replace the icon.
- ✔ **Invalid categories** (`productivity`, `developer-tools`). **Rule:** use the official category list.
- ✔ **Port collisions with official apps** (ARTEX 8787 = readarr, DeepSeek Harness 8734 = kimai). If a user installs both, the second app gets no route. **Rule:** check against the official store.
- **amd64-only images** (ARTEX, BrowserPier, Doop wrapper) fail to pull on a Raspberry Pi. **Rule:** use multi-arch images. Otherwise state it in the description and the README Arch column, and acknowledge it in the file.
- **Apps were removed with no recorded reason**, stranding existing installs. **Rule:** prefer `disabled: true`, and record why in the commit message.

## Automation (update workflows)

`.github/workflows/update-*.yml` bump images nightly. When you write or modify one:

- **Regex YAML edits are dangerous.** An `(?s)` flag made `.*` swallow the rest of the manifest after `releaseNotes`. Edit with a YAML-aware tool, or at minimum:
  1. re-parse the result
  2. assert the key set is unchanged
  3. run `scripts/check.sh <id> --base origin/master` before committing
- **Never push a digest change without a version bump**; it never reaches devices.
- **Verify the digest is a multi-arch index** with amd64 and arm64. Use an index-only `Accept` header and inspect `manifests[].platform`.
- **Open a PR instead of pushing to `master`.** Every push to `master` ships to every device within minutes.
- **Version regexes must accept the store's suffixes** (`-umbrel.N`). Otherwise the job fails every night after the first patch release.
- **Treat a database major-version change upstream as a stop**, not a bump; see the Keeper workflow's PostgreSQL major check.
- **Keep releaseNotes regexes in step with the YAML.** They must handle `releaseNotes: ""` and multi-paragraph `>-` blocks.

## Review checklist

Copy this when auditing a package:

```
Review: yakitori-<slug>
- [ ] scripts/check.sh <id> --check-images --check-urls  → errors fixed or acknowledged
- [ ] Every sibling reference is <id>_<svc>_1 (grep compose for "@", "://", "_HOST")
- [ ] Every durable path is under data/, directories only, .gitkeep committed
- [ ] No package file outside the update whitelist is mounted or needed at runtime
- [ ] Whitelist audited route by route; bypasses disclosed in description
- [ ] Every DB/cache password-protected with derive_entropy secrets
- [ ] Canonical URL derived, overridable, works over IP and https
- [ ] Healthchecks + health-gated depends_on; Pi-friendly start periods
- [ ] Version bumped for every runtime change since the last release
- [ ] Description: setup steps, auth bypasses, host privileges, arch caveats
```
