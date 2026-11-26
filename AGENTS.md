# Yakitori's App Store: agent guide

This repository is an Umbrel **community app store**. Every push to `master` reaches users' devices within minutes.

For any work on an app package, load the repo-local skill first:
[`.agents/skills/packaging-yakitori-umbrel-apps/SKILL.md`](.agents/skills/packaging-yakitori-umbrel-apps/SKILL.md).

That covers adding an app, updating or fixing a `yakitori-*` package, reviewing packages, and editing the update workflows.

- Keep each change scoped to one app directory.
- Before every commit, run `.agents/skills/packaging-yakitori-umbrel-apps/scripts/check.sh <app-id> --base origin/master`.
- Commit as `yakitori <89288375+Oni-giri@users.noreply.github.com>`.
