# Console update fixture

Use this when a claim needs the browser-hosted Console's own update lifecycle: a newer release detected, the update notice, acceptance, the worker's npm install and handoff, and the outcome the next Console reports. It replaces no part of [Isolated Console setup](setup.md); every command below goes through the same wrapper and run directory, and the wrapper's start checklist still applies.

## Why a plain dev build never offers an update

The product only offers and installs an update when all of these hold, so the fixture builds them instead of mocking UI or API state:

- **Stable channel.** `readFleetConsoleRelease` reads the running package's `package.json`; `private: true` (every checkout) means channel `local`, which never looks for a release and refuses `apply` with 403.
- **Not a Desktop managed runtime.** A package root at `…/console/latest` with a valid Desktop marker is refused in place (`managed_runtime_update_requires_relaunch`); that lane belongs to the Desktop shell update and is not covered here.
- **A release only from GitHub.** The manifest and tarball URLs are derived from `CONSOLE_RELEASE_REPOSITORY` and only `https` GitHub release hosts pass the download allowlist. No environment variable redirects them (`FLEET_CONSOLE_RELEASE_TAG` only picks a tag), so the fixture answers those URLs inside each Node process with a `NODE_OPTIONS --import` preload that every worker and respawned `serve` inherits, and it refuses every other non-loopback `fetch`.
- **A valid, newer manifest.** Stable `X.Y.Z` above the running version, `tag` `v<version>`, tarball name `fleet-console-<version>.tgz`, and the exact size and sha256 of the served bytes (`parseConsoleReleaseManifest`).
- **A detectable global install.** `npm` (or `pnpm`) on `PATH`, `npm root -g` whose realpath contains the running package root, and a writable root and `prefix -g`/bin. The worker repeats this check after the old Console stops, runs `npm i -g --force <tarball>` with the inherited environment, and starts the new `serve` with `process.execPath`.

The last point decides the process shape: the wrapper's per-call `PATH` directory (with `node` and `npm`) is deleted when its command exits, and the first `serve` exits during the update. The fixture's `serve` mode is therefore a supervisor that stays alive as the wrapped command, starts the installed `cli.mjs serve` as its child, and stops whichever Console holds the lock at the end.

## Prepare and run

[`scripts/console-update-fixture.mjs`](../scripts/console-update-fixture.mjs) builds everything under `<run-dir>/update-fixture`. Build the worktree's Console first. Its `prepare` step installs the built `dist` as the current version into an owned npm prefix with a real `npm i -g`, and publishes the same bytes as the target version (current patch + 1 unless `--target-version`). Only `package.json` differs: the published-manifest rules from `scripts/pack-fleet-console-manifest.mjs`, the version, and no registry dependencies. The external dependencies resolve through `<prefix>/node_modules`, a link to the worktree's `node_modules` placed outside the npm-managed root, because npm fails a global install whose package root holds that link. `HOME` from the wrapper keeps npm's cache and user config owned; `NPM_CONFIG_PREFIX` keeps the global root owned. Nothing is published and the registry is not contacted.

```bash
W=<worktree>; E2E_DIR=<repo-root>/.fleet/e2e-<role>-<short-id>; S=$W/.claude/skills/console-e2e/scripts
node $S/isolated-env.mjs --run-dir "$E2E_DIR" --bin npm --check -- node $S/console-update-fixture.mjs serve --dir "$E2E_DIR/update-fixture"
node $S/isolated-env.mjs --run-dir "$E2E_DIR" --bin npm \
  -- node $S/console-update-fixture.mjs prepare --worktree "$W" --dir "$E2E_DIR/update-fixture" [--delay-ms 1500] [--fail-install]
node $S/isolated-env.mjs --run-dir "$E2E_DIR" --bin npm \
  -- node $S/console-update-fixture.mjs serve --dir "$E2E_DIR/update-fixture"     # managed background process
```

- `--delay-ms` holds each release response so the requesting and progress states stay visible on screen.
- `--fail-install` gives the target package a `postinstall` that exits 41: the worker records `install-failed`, npm restores the current version, and the worker brings a Console back on the same port.
- A fresh fixture directory per scenario: `prepare` refuses a non-empty one.

Then either accept in the UI with the [selected driver](agent-browser.md) after the [onboarding seed](setup.md#first-load-onboarding-state), or drive the API:

```bash
node $S/isolated-env.mjs --run-dir "$E2E_DIR" -- node $S/console-update-fixture.mjs drive --dir "$E2E_DIR/update-fixture" --run-dir "$E2E_DIR"
```

`drive` reads the lock's port and pid only, then sends `GET /api/v1/status`, `POST /api/v1/updates/check`, and `POST /api/v1/updates/apply` with the exact Origin, polls `/api/v1/updates/progress` until `completed` or `failed`, and writes `drive.json`. It exits non-zero unless `apply` returned 202 and the outcome matches the fixture mode. Without a Theater, the browser shows the notice inside the host avatar menu at the bottom of the sidebar, not on the page itself.

## Evidence and cleanup

Read lifecycle values from these files, never from the lock body:

| File (under `<run-dir>`) | What it holds |
|---|---|
| `update-fixture/lifecycle.jsonl` | Supervisor samples every 200 ms: `lock` (pid/port), `progress` (phase and record fields), `installed-version`, `first-serve-exited` |
| `update-fixture/release-requests.jsonl` | Each answered release asset (`asset`, `route`, `status`) and each `blocked` host |
| `update-fixture/drive.json` | Status before/after, `check`, `apply`, and the final progress response |
| `console/update-progress.json`, `console/fleet-console-update-*.log` | The worker's own record and log |

End with `node $S/isolated-env.mjs --run-dir "$E2E_DIR" -- node $S/console-update-fixture.mjs stop --dir "$E2E_DIR/update-fixture"`. It signals the recorded supervisor only after matching its command line, and the supervisor runs the installed `cli.mjs stop` and logs `supervisor-stopped` with `lockRemains`. Confirm `lockRemains: false`, that the recorded Console pids are gone, and that the port has no listener, then copy the evidence out and delete the owned run directory (the `node_modules` link is removed, not followed).

Not covered: Desktop-hosted Console updates, pnpm global installs, Windows, a real GitHub Release, and the registry dependency install of a published package.
