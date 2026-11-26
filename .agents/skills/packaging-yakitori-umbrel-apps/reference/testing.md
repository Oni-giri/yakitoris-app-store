# Testing on umbrelOS

Static checks prove the files are well-formed. Only an install through umbrelOS proves the app works. Never report a package as working from these alone:

- linting
- `docker compose up`
- a successful image pull
- `state: ready`

## Contents
- Environments
- Put the working copy on the device
- Scripted smoke test
- Fresh install checklist
- Update path checklist
- Evidence to report

## Environments

- **A real Umbrel device over SSH.** This is the best option. Set up key auth with `ssh-copy-id umbrel@umbrel.local`, because the scripts use `ssh` and `sudo` non-interactively. The `umbrel` user has sudo.
- **Containerized umbrelOS on an amd64 Linux host with Docker**, for a disposable test:

  ```bash
  docker run -d --name umbrelos-test --privileged --network host \
    -v umbrelos-test:/data ghcr.io/getumbrel/umbrelos:<current-version> /sbin/init
  ```

  It needs privileged systemd and nested Docker. Use a fresh volume per test. Finish onboarding in the browser at `http://<host>` before you install apps.
- **No device available?** Say so explicitly in the summary and list what was not runtime-tested.

**Which architecture?** Test on whatever you have and record it. arm64 (a Raspberry Pi) is where startup timeouts and memory problems show up first.

## Put the working copy on the device

On the device, the store clone lives at `~/umbrel/app-stores/<owner>-<repo>-github-<hash>/`. Find it with:

```bash
ssh umbrel@umbrel.local 'ls -d ~/umbrel/app-stores/*yakitoris-app-store*'
```

If the store is not added yet, add `https://github.com/Oni-giri/yakitoris-app-store` from App Store → ··· → Community App Stores.

Sync **one** app directory over the clone:

```bash
rsync -av --delete --exclude=.gitkeep yakitori-<slug>/ \
  "umbrel@umbrel.local:<store-dir>/yakitori-<slug>/"
```

- **Mirror the real install.** `--exclude=.gitkeep` matches what umbrelOS does on a real install, because its clone strips `.gitkeep` files.
- **Re-sync after a push.** umbreld re-clones the store whenever `master` moves, which undoes the sync.
- **New apps appear at once.** umbreld reads the registry from disk on every query, so a synced app is listed right away. If `appStore.registry.query` does not list it, the manifest was rejected. Common causes are a YAML error, a bad `storage` block, or an id without the `yakitori` prefix. Find the reason with `sudo journalctl -u umbrel --since "10 min ago" | grep -i manifest`.

**Lifecycle commands** (run on the device as root):

```bash
sudo umbreld client appStore.registry.query | grep -o '"id":"yakitori-[^"]*"'
sudo umbreld client apps.install.mutate --appId yakitori-<slug>
sudo umbreld client apps.update.mutate  --appId yakitori-<slug>
sudo umbreld client apps.restart.mutate --appId yakitori-<slug>
sudo umbreld client apps.state.query    --appId yakitori-<slug>
sudo umbreld client apps.logs.query     --appId yakitori-<slug>
sudo umbreld client apps.uninstall.mutate --appId yakitori-<slug>
```

**Lower-level inspection:**

```bash
sudo docker ps --filter name=yakitori-<slug>
sudo cat ~/umbrel/app-data/yakitori-<slug>/app-gateway.json
ls -la ~/umbrel/app-data/yakitori-<slug>/data
```

## Scripted smoke test

Run from the repository root:

```bash
.agents/skills/packaging-yakitori-umbrel-apps/scripts/device-test.sh yakitori-<slug> umbrel@umbrel.local [--update]
```

The script performs these steps in order:

1. Syncs the package.
2. Installs it. With `--update`, it updates the installed app instead.
3. Waits for the `ready` state.
4. Waits for the port to answer over `http://` and `https://`.
5. Restarts the app and checks that the port answers again.
6. Prints container status, health, and the tail of each service's logs.

It does **not** replace the checklists below. A browser workflow is still required.

## Fresh install checklist

```
- [ ] Installs through Umbrel; reaches ready
- [ ] Opens from the Umbrel home screen; also https://<device>.local:<port> and http://<ip>:<port>
- [ ] First-run flow works (sign-up / seeded admin with shown credentials / deterministic password)
- [ ] Main workflow done for real (create a record, upload a file, connect MCP client, run a job)
- [ ] Every whitelisted path: works without Umbrel cookie for its client; a non-whitelisted page still redirects to login
      curl -s -o /dev/null -w '%{http_code}\n' http://<device>.local:<port>/<path>
- [ ] Settings page shows declared environment/folderAccess entries; changing one restarts and applies
- [ ] Restart → data, login session or account, and config persist
- [ ] Files under data/ owned by the expected uid; nothing durable outside data/
- [ ] docker ps: all long-running containers healthy, one-shot jobs exited 0
- [ ] Settled logs: no repeated errors, no secrets printed
- [ ] (if storage.dataRoot) Optional: move data to an external ext4 drive in settings, app still starts
```

## Update path checklist

```
- [ ] Install the CURRENTLY SHIPPED version (store at origin/master, no rsync)
- [ ] Create real state (account, records, uploads)
- [ ] rsync the new package; registry shows the new version
- [ ] Update through Umbrel; reaches ready
- [ ] State from before the update is intact; migrations ran (check logs)
- [ ] New directories/hooks/exports behave on the existing install
- [ ] Restart once more; still intact
```

## Evidence to report

Report these items to the user, or in the commit message body for risky changes:

- the app ID and version tested
- the umbrelOS version and architecture
- whether this was a fresh install, an update from a given version, or both
- the routes opened, and the workflow performed
- persistence after a restart
- intentional checker warnings, and `yakitori-allow` exceptions
- what was not tested: paid or external accounts, OAuth providers, hardware

**What must never appear** in reports or screenshots: secrets, cookies, tokens, or `APP_PASSWORD` values.
