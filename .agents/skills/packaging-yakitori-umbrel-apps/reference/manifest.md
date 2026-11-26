# umbrel-app.yml for Yakitori's store

## Contents
- Field order and skeleton
- Field rules
- Description and release notes copy
- App settings: environment and folderAccess
- Optional fields

## Field order and skeleton

Use this order. It matches the official store and the store's own newer packages.

```yaml
manifestVersion: 2.0
id: yakitori-example
storage:
  dataRoot: data
category: developer
name: Example
version: "1.4.2"
tagline: One line, under ~80 characters, no trailing period
icon: https://raw.githubusercontent.com/<owner>/<repo>/v1.4.2/path/icon.svg
description: >-
  What it is and why you would run it.


  🛠️ SET-UP INSTRUCTIONS


  First-run steps.


  ⚠️ GOOD TO KNOW


  Requirements, auth bypasses, caveats.
releaseNotes: >-
  Initial Umbrel package of Example 1.4.2 (amd64 and arm64), ...
developer: Upstream Author or Org
website: https://example.com
dependencies: []
repo: https://github.com/<owner>/<repo>
support: https://github.com/<owner>/<repo>/issues
port: 8790
requiresHttps: true
gallery:
  - https://raw.githubusercontent.com/<owner>/<repo>/v1.4.2/docs/screenshot-1.png
path: ""
defaultUsername: ""
defaultPassword: ""
submitter: Yakitori
submission: https://github.com/Oni-giri/yakitoris-app-store
```

Put `permissions:`, `backupIgnore:`, `folderAccess:`, `environment:` and `widgets:` after `defaultPassword` (or `deterministicPassword`) and before `submitter`, as the template and newer packages do.

## Field rules

**Identity and versions**

- **`manifestVersion`**: use `2.0` for new packages. Lower it only if the package uses none of `requiresHttps`, `storage`, `environment` or `folderAccess` and must run on umbrelOS 1.x. umbrelOS checks it on install **and on update**: raising it means devices on an older OS keep being offered the update, and it fails every time. Raise it only when the package needs the newer feature.
- **`id`**: `yakitori-<slug>`. It must equal the directory name. Lowercase letters, digits and `-` only.
- **`version`**: always quoted.
  - Use the upstream release in upstream's format, without a leading `v` unless upstream's own version string has one.
  - For package-only changes, use `<upstream>-umbrel.N`, starting at 1 and incrementing (`0.16.0-umbrel.2`). This is the store convention; the official store uses `-patch.N` for the same purpose. Drop the suffix at the next upstream bump.
  - If upstream has no releases, use the short commit SHA.
  - Never use `latest`.

**Store listing**

- **`category`**: one of `ai`, `automation`, `bitcoin`, `crypto`, `developer`, `files`, `finance`, `media`, `networking`, `social`. Anything else is a lint error and may break filtering in the UI.
- **`icon`**: an absolute https URL to a square SVG or PNG, at least 256 px, rendered on a rounded tile.
  - Prefer an upstream raw URL pinned to a tag or commit SHA, since branch URLs can change underneath us.
  - If upstream has no suitable icon, commit `icon.svg` in the app directory and reference `https://raw.githubusercontent.com/Oni-giri/yakitoris-app-store/master/<id>/icon.svg`.
  - Use flat SVGs without masks, filters or `<defs>`-heavy constructs; complex SVGs have rendered badly before.
  - Icons are cached by URL. When you replace an icon, **change the filename** (for example `icon-v2.svg`).
- **`gallery`**: absolute URLs or `[]`. Pin them to tags or SHAs like the icon. Upstream README screenshots and Open Graph images are typical sources. Check each URL returns 200 (`check.sh --check-urls`).
- **`developer`**: the upstream author or organisation, not us, unless the app is first-party.
- **`website`**, **`repo`** and **`support`**: valid URLs. `repo` may be `""`. `support` is usually the upstream issues page.
- **`dependencies`**: `[]` unless the app needs **another installed Umbrel app**. Same-compose databases are never dependencies. A dependency on an official app is only allowed if that app's `exports.sh` contract is read and consumed exactly.
- **`submitter: Yakitori`**, **`submission: https://github.com/Oni-giri/yakitoris-app-store`**: the store convention.

**Launch and credentials**

- **`port`**: the host-facing port.
  - It must be unique across this store, the official store, and the reserved ports 80, 443, 2000 and 40000–49999. Use upstream's default when it is free; otherwise pick a free port in 8700–8899.
  - It is **not** the container port; that goes in `app_proxy` `APP_PORT`.
- **`path`**: `""`, or a subpath starting with `/`. Only the UI uses it to build the launch URL.
- **`requiresHttps: true`**: makes the dashboard open the app over https. It changes no routing; the port always serves both http and https.
  - Set it when the app needs a secure context: Secure cookies, `crypto.subtle`, clipboard, service workers or WebAuthn.
  - Also set it when its auth or OAuth flows compare against an https origin.
  - It requires `manifestVersion` ≥ 2.0.
- **`defaultUsername`** and **`defaultPassword`**: shown to the user, but they do not configure anything.
  - Use `""` when the app has a sign-up flow.
  - If the package seeds an admin, wire its password to `${APP_PASSWORD}`, set `deterministicPassword: true`, and set `defaultUsername`.
  - Never ship a well-known static password.
- **`deterministicPassword: true`**: the UI shows `APP_PASSWORD`. Set it only when the app actually uses `${APP_PASSWORD}` for that login.

**Lists that must not be null**

- `gallery`, `dependencies` and `releaseNotes` must never be null or missing. Use `[]` and `""`.

## Description and release notes copy

- **YAML folding**: use `>-`. A single newline folds into a space, so separate Markdown paragraphs with **two** blank lines. For bullet lists, put a blank line before the list and between items.
- **What the description covers**, in order:
  1. what the app does
  2. what this package runs (services, bundled DB)
  3. 🛠️ SET-UP INSTRUCTIONS: first-run account creation, OAuth setup, MCP connection URL
  4. 🤖 AI ASSISTANTS, when the app has MCP or an API
  5. ⚠️ GOOD TO KNOW: the OS requirement, which paths bypass Umbrel login, host privileges, single-architecture caveats, and data that must be backed up
- **URLs in copy**: write `https://<device>.local:<port>`. Never hardcode `umbrel.local`.
- **`releaseNotes` for updates**: write for someone upgrading. Cover:
  - user-visible changes
  - migrations and any required action
  - security fixes
  - a link to the upstream release, for example "Updates Example to 1.5.0. See what changed upstream: <url>"
  
  Replace the notes entirely on each version; never append.

## App settings: environment and folderAccess

**`environment:`** lets users override environment variables from the app's settings page.

```yaml
environment:
  - name: PUBLIC_URL
    services:
      - web
    note: >-
      Main address used for links and OAuth redirects. Leave unset for
      https://<device>.local:8790.
  - name: LOG_LEVEL
    default: "info"
    options: ["debug", "info", "warn"]
    services:
      - web
```

- **Every service listed must exist.** Otherwise the entry silently disappears.
- **`default` is a display placeholder.** The real default must also be set in compose or come from upstream.
- **Good candidates:** canonical URL, trusted origins, OAuth client IDs and secrets, optional integrations, feature toggles.
- **Never expose** derived secrets, database URLs or packaging internals.
- **Notes** are at most 300 characters.

**`folderAccess:`** lets the user bring a folder from Home, an external drive or a network share.

```yaml
folderAccess:
  - id: library
    name: Library
    note: Select a folder; it appears in the app at /library.
    mounts:
      - service: web
        targetPath: /library
        readOnly: true
```

**Renames:** never rename `environment[].name`, `folderAccess[].id` or service names after release, because users' saved values are dropped.

## Optional fields

| Field | Use |
|---|---|
| `permissions: [GPU]` | The app has real GPU acceleration. umbreld injects devices into every service; never map `/dev/dri` yourself. |
| `permissions: [STORAGE_DOWNLOADS]` | The compose file mounts `${UMBREL_ROOT}/data/storage/downloads...` (keep this legacy path; umbreld rewrites it). |
| `backupIgnore:` | Caches, search indexes, thumbnails, model downloads, e.g. `data/search/*`. Never user content or keys. |
| `widgets:` | Only with a real unauthenticated JSON endpoint on a service, `service:port/path`, response includes `refresh`. |
| `defaultShell` | Service whose container the Umbrel terminal opens. |
| `implements:` | Only for drop-in replacements of another app's dependency contract. Effectively never used in this store. |
| `disabled: true` | Hides the app from the store while keeping installed copies. Prefer this to deleting a released app. |
