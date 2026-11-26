# docker-compose.yml for Yakitori's store

## Contents
- Shape
- Images
- Service-to-service networking
- Persistence
- Users and file ownership
- Healthchecks, ordering, shutdown
- Inline config instead of package files
- Secrets on the shared network
- Host access
- Resource behaviour

## Shape

```yaml
# <App> <version> (<services>), adapted for umbrelOS 2.0+:
#   1. <every deviation from upstream compose, and why>
#   2. ...

services:
  app_proxy:
    environment:
      APP_HOST: yakitori-example_web_1
      APP_PORT: 8080

  web:
    image: ghcr.io/owner/example:1.4.2@sha256:<index digest>
    restart: on-failure
    ...
```

- **No `version:` key.** It is obsolete in Compose v2.
- **No top-level `networks:` and no `volumes:` blocks.** One exception is an `internal: true` network, used to isolate an untrusted sandbox such as a compiler or code runner. When you add one, also attach the services to `default` explicitly, and test it.
- **The header comment is mandatory.** It is the reviewer's map of every adaptation. On the device the patcher strips comments, but they remain in git.
- **Never set `container_name`.** umbreld sets it to `<id>_<service>_1`. The only exception is when the app hardcodes a hostname, and then you must leave a comment.

## Images

- **Pin every service, including** databases, nginx and busybox init jobs, and every image named in an environment variable that the app pulls at runtime.
- **Get the reference from the script.** Run `scripts/resolve-image.mjs <image>:<tag>`. It prints the multi-arch **index** digest and fails unless both linux/amd64 and linux/arm64 are present. Never use a per-platform manifest digest; it pins a single architecture.
- **Pick the right tag:**
  - Use the exact release tag, such as `1.4.2`, `v1.4.2` or `17.6-alpine`. Avoid moving tags (`latest`, `main`, `17`, `alpine`) even when pinned by digest. A moving tag hides which release is running and defeats the update workflows.
  - If upstream publishes only `latest`, look for a commit or date tag first. Failing that, use `latest@sha256:…` and add a `# yakitori-allow: image.latest <reason>` comment explaining why no versioned tag exists.
- **Stay on the database's major version.** Never bump a database major (Postgres 16→17, MongoDB 6→7) by changing the tag. The existing data directory will refuse to start. Keep the major unless you ship a tested migration.
- **Wrapper images** (`ghcr.io/oni-giri/*`): use one only when upstream has no usable multi-arch image or needs glue that compose cannot express. The image must be built by CI for both architectures from a public repo, with versioned tags.
- **No `build:`, and no `image:` with `${...}`.** umbreld pulls the literal string.

## Service-to-service networking

Every Umbrel app's containers share one Docker network, `umbrel_main_network`. Docker DNS resolves **service names and aliases across all apps** on that network.

```yaml
# WRONG: "db" also matches dozens of other apps' services
DATABASE_URL: postgres://example:${APP_EXAMPLE_DB_PASSWORD}@db:5432/example
# RIGHT
DATABASE_URL: postgres://example:${APP_EXAMPLE_DB_PASSWORD}@yakitori-example_db_1:5432/example
```

- **Name every sibling by its full container name**: `<app-id>_<service>_1`. This applies to URLs, DSNs, nginx upstreams, `*_HOST` variables and healthcheck targets that point at other services. Inside its own container a service may use `127.0.0.1`.
- **When the app hardcodes a short hostname** (for example it always connects to `redis`), look for a config option or env var that changes it, and set it to the full container name. If there is none, change the hostname in an entrypoint override or a wrapper image, and explain this in the header comment. Relying on a generic short name such as `redis` is never safe, and neither is a network alias, because aliases are visible to every app too.
- **nginx routers:** use `resolver 127.0.0.11 valid=30s ipv6=off;`, put upstreams in variables (`set $$up yakitori-example_web_1:8080;`), and forward `Host $$http_host`, never `$$host`, which drops the port.
- **Published ports:** never publish the web UI with `ports:` when `app_proxy` can front it.
  - Publish raw ports only for non-HTTP protocols or clients that cannot use the gateway.
  - Always write explicit mappings: `"7438:7438/tcp"`.
  - Published ports share the host port space with every manifest port in both stores.

## Persistence

**What to mount:**

- Mount durable state as bind mounts of directories under `${APP_DATA_DIR}/data/<name>`. Durable state means databases, uploads, config written by the app, generated keys, plugins and search indexes that can't be rebuilt.
- Write the source as `${APP_DATA_DIR}/data/...`. Only that form (or `$APP_DATA_DIR/data/...`) is redirected when the user moves the data root; `${APP_DATA_DIR:-x}/data` or `./data` are not.
- Commit every source directory with `data/<name>/.gitkeep`. It then exists on first start and is owned by 1000:1000. Directories umbreld or Docker create instead are owned by root.

**What breaks:**

- **Single-file mounts under `data/`.** umbreld runs `mkdir -p` on them before every start. File mounts are acceptable only for top-level rendered templates, such as `${APP_DATA_DIR}/config.yml` rendered from `config.yml.template`.
- **Durable data outside `data/`.** It does not move with the data root and is easy to miss in backups.
- **Named volumes.** They persist outside app data, survive uninstall, and are not moved.
- **Anything kept only in the container filesystem.** It is lost on every update, because containers are recreated.

**Other rules:**

- Short syntax only, `- ${APP_DATA_DIR}/data/db:/var/lib/postgresql/data[:ro]`: the official linter rejects long syntax. On `data/` mounts with `storage.dataRoot`, only `ro`, `rw`, `z`/`Z`, propagation and consistency flags are allowed; anything else fails the start.
- Do not create a path segment `/data/storage` inside app data. umbreld rewrites that substring.
- For Postgres 18+ images, mount `/var/lib/postgresql`, not `.../data`, because the image layout changed. Check each image's documented data path at the pinned version.

## Users and file ownership

Package directories arrive owned by `1000:1000`. Pick one of the patterns below per image:

| Image behaviour | Pattern |
|---|---|
| Runs fine as an arbitrary UID | `user: "1000:1000"` (set `HOME=/tmp` if it writes to `$HOME`) |
| Exposes `PUID`/`PGID` (linuxserver etc.) | Set them to 1000 |
| Has a fixed internal user (e.g. uid 1001, 65532) | One-shot `init` service from the same image, `user: "0:0"`, `chown -R <uid>:<gid> /data`, then `depends_on: {init: {condition: service_completed_successfully}}` |
| Official postgres/mariadb/redis | Leave `user:` unset. Their entrypoints run as root, chown the data dir, then drop privileges. Forcing `user: 1000` breaks `initdb`. |
| s6-overlay / supervisor images | Leave `user:` and `init:` unset (`/init` must be PID 1 as root) |

Verify ownership after the first start and after a restart. Exec into the container and write a file to the mounted path.

## Healthchecks, ordering, shutdown

- **Healthchecks:** every service that another service waits on gets a `healthcheck` with:
  - `start_period`, generous enough for first boot on a Raspberry Pi, where initdb and migrations run: 30–120 s
  - `interval`, `timeout` and `retries`
- **Probe `127.0.0.1`, not `localhost`**, which may resolve to `::1` while the app listens on IPv4 only. Use only tools that exist in the image (`wget`, `curl`, `pg_isready`, `redis-cli`, or `node -e`).
- **Postgres probe:** `pg_isready -h 127.0.0.1 -U <user> -d <db>`. Use TCP, because on first boot the image runs a temporary socket-only server, and a socket probe passes too early.
- **Ordering:** use `depends_on` with `condition: service_healthy` for long-running dependencies, and `condition: service_completed_successfully` for one-shot migrate or init jobs.
- **Restart policy:**
  - `restart: on-failure` on long-running services.
  - One-shot jobs may omit `restart`, or use `on-failure` when re-running them is safe.
  - Keep `restart: "no"` with a comment when re-running would be harmful.
- **Process handling:** use `init: true` when the main process does not reap children or handle SIGTERM. Never use it on s6 or tini images.
- **Shutdown:** `stop_grace_period: 1m` for databases and anything that flushes on shutdown. Compose's default is 10 s, then SIGKILL.
- **Migrations:** run them in the app's own startup or in a one-shot `migrate` service. Never run them in hooks. They must be idempotent and safe on retry, because install and start are retried up to 3 times.

## Inline config instead of package files

Package files other than compose, `exports.sh`, top-level `*.template`, `torrc` and `hooks/` are never updated on existing installs. Inline small config files in compose:

```yaml
  router:
    image: nginx:1.27.5-alpine@sha256:...
    entrypoint:
      - /bin/sh
      - -c
      - printf '%s' "$$NGINX_CONF" > /etc/nginx/conf.d/default.conf && exec /docker-entrypoint.sh nginx -g 'daemon off;'
    environment:
      NGINX_CONF: |
        server {
            listen 80;
            location / { proxy_pass http://$$up; }
        }
```

- **Escape `$`.** Every `$` that must reach the container literally is written `$$` in compose: nginx variables, shell variables, JS template strings. A single `$` is interpolated by compose from Umbrel's environment, usually as an empty string.
- **Use a template for large files.** For a large config, or one that must be a file at a fixed path, use a top-level `<name>.template` rendered by envsubst; see [lifecycle.md](lifecycle.md).
- **Keep entrypoint overrides short.** Use `exec` the real entrypoint as the last step, so signals reach it. Longer logic belongs in a wrapper image.

## Secrets on the shared network

- **Password-protect every database, cache and queue:** Postgres, MySQL, Redis/Valkey (`--requirepass`), MinIO, Meilisearch and so on. Any container on any app can reach them.
- **Derive passwords in `exports.sh`** as `APP_<APP>_<PURPOSE>` with their own `derive_entropy` label.
- **Watch the format.** Derived values are 64 hex characters. When the app needs base64 or a specific byte length, convert them in `exports.sh` and add a comment explaining why. The keeper and infisical packages are examples.

## Host access

| Feature | Status |
|---|---|
| `/var/run/docker.sock` | Forbidden. If the product runs containers, use an isolated Docker-in-Docker sidecar with its socket in `data/` (see yakitori-act-ci) and acknowledge `access.privileged`. |
| `privileged`, `cap_add`, `devices`, `network_mode: host`, `pid: host`, `security_opt` relaxations, host path mounts | Only when the product cannot work otherwise. Acknowledge with `# yakitori-allow: access.<rule> <reason>` and disclose in the description. |
| Hardening (`cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `read_only`, `mem_limit`, `pids_limit`) | Encouraged for sandbox/runner services. |
| `extra_hosts: ["host.docker.internal:host-gateway"]` | Fine when the app must reach host services. |

## Resource behaviour

- **Targets.** The app must run on a Raspberry Pi 4/5 with about 4 GB of RAM, alongside other apps.
- **Memory.** Tune or cap memory-hungry defaults: JVM heap, Postgres `shared_buffers` auto-tuning, Elasticsearch, worker counts.
- **Telemetry.** Disable upstream telemetry and analytics in the package (for example `DO_NOT_TRACK=1` and app-specific flags), and say so in the header comment.
