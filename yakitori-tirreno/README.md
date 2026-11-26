# tirreno for umbrelOS

In-application security: event ingest, risk scoring, review queue, audit trail.
One collector on your Umbrel, fed by your apps and by remote hosts over
Tailscale.

```
yakitori-tirreno/
├── umbrel-app.yml          # port 8585
├── docker-compose.yml      # app_proxy + server + db, digest-pinned
├── exports.sh              # canonical host for absolute URLs
├── hooks/pre-start         # per-device database password
├── icon.webp
└── vps/                    # senders for a remote host (sh + Node, no deps)
```

## First run

Open the app, go to `/signup`, create the admin account. Signup closes after the
first account exists and there is no password-reset flow by default
(`ALLOW_FORGOT_PASSWORD=false`, no SMTP), so keep that password somewhere real.

## How it is wired

| | |
|---|---|
| `app_proxy` → `server:80` | Dashboard stays behind Umbrel's login. `PROXY_AUTH_WHITELIST: "/sensor,/sensor/*"` lets the ingest endpoint through, because remote senders cannot complete a browser login and authenticate with an API key instead. |
| `server` runs as **root** | Upstream `CMD` is `cron && apache2-foreground`. Vixie cron refuses to start as an unprivileged uid, and with `&&` a cron failure means Apache never starts — `user: "1000:1000"` would give you a container that never serves. |
| `command:` override | The upstream entrypoint bootstraps the schema from `DATABASE_URL`, then the override deletes `/var/www/html/install` before Apache serves it. `.htaccess` explicitly allows `/install/index.php` through, and Umbrel's proxy cannot path-filter, so removal is the only way to keep the installer off the web. |
| cron | In the same container, every 10 minutes: risk scores, enrichment, totals, retention. `LOG_TO_STDOUT=true` puts its output in Umbrel's app log view. |
| `data/config` | Holds `config.local.ini`, which holds the generated **PEPPER**. The image mints it on first boot and ignores any `PEPPER` env var, so this directory is the only copy. Back it up with the database or neither is restorable. |
| `secrets/db-password` | Generated once by `hooks/pre-start` and read via `POSTGRES_PASSWORD_FILE` / `cat` in the command. Never in the compose file, never in `docker inspect`, stable across updates. |
| `db` as `1000:1000` | Matches the data-dir owner; the official postgres image then skips its root-only initdb-as-postgres path. Bootstrapping needs a superuser, which `POSTGRES_USER` is. |

`assets/logs` is deliberately not persisted: it only holds container-local logs,
and mounting an empty volume over it would hide the `error.log` the image creates
at build time.

## Reporting from a remote VPS over Tailscale

1. Tailscale app signed in on this Umbrel, VPS joined to the same tailnet.
2. Get this Umbrel's tailnet name (`tailscale status` on the VPS, or the admin
   console): `umbrel.tailnet-xxxx.ts.net`.
3. Ingest URL: `http://umbrel.tailnet-xxxx.ts.net:8585/sensor/`.
4. Create one API key per source in tirreno. Each key has its own event stream
   and Logbook, so a compromised host cannot poison another source's baseline.
5. Send an event:

```sh
TIRRENO_URL=http://umbrel.tailnet-xxxx.ts.net:8585 \
TIRRENO_KEY=<api key> \
./vps/report-event.sh alice 203.0.113.50 /login account_login
```

```sh
TIRRENO_URL=... TIRRENO_KEY=... node vps/reporter.mjs alice 203.0.113.50 /login account_login
```

Contract, from tirreno's sensor docs: `POST /sensor/`, form-urlencoded, key in the
`Api-Key` header. `userName`, `ipAddress`, `url`, `eventTime` (UTC
`Y-m-d H:i:s.v`) are required. **204** accepted, **200 empty** rejected (unknown
key or missing field), **429** rate limited at 10 req/s per key, **403** trailing
slash missing.

If you mostly open the dashboard over the tailnet, set the canonical host in
`exports.sh` to the tailnet name — otherwise a remote login redirects to
`umbrel.local` and dies. With Umbrel login enabled, a non-whitelisted path
answers with a login page rather than a 204, which the senders report as
`rejected`; that means the whitelist, not the API key, is the thing to check.

## Limits

- **Ingest is per-request, not batched.** Fine for app events; not a log shipper.
- **Enrichment is opt-in** and stays offline until a key is configured. Without
  it you get only signals from your own event stream: no VPN/Tor flags, no breach
  data, no cross-install profile counts.
- **No TLS in the container** (`FORCE_HTTPS=false`): Umbrel's proxy speaks plain
  HTTP. Over the tailnet that is WireGuard-encrypted; on the LAN it is not.
- **Do not port-forward this.** It stores IP addresses, emails and names.
