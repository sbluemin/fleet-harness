# Fleet Console Desktop

Fleet Console Desktop is the optional Electron shell for Fleet Console. A packaged shell does not embed Fleet Console or a Node sidecar. It first shows a passive local entry page, provisions the current Console runtime when needed, then hands the same sandboxed `BrowserWindow` to the verified loopback `/console/` URL.

## Runtime and data boundaries

Desktop-managed code lives under:

```text
~/.fleet/desktop/runtime/
├─ node/
└─ console/
   └─ latest/
```

Installation temporarily uses `console/.staging-*`; replacing `latest` can temporarily use `latest.rollback`. A failed installation preserves a usable previous `latest` or leaves no partial installation. This runtime directory is removable code, not user data.

Console data remains in `~/.fleet/console`: durable state, captures, and lock files keep their existing ownership and semantics. `FLEET_CONSOLE_DIR` is the explicit operator/test override. Desktop never copies Console service, React UI, PTY, provider, plugin, or durable-state behavior into Electron.

## Startup journeys

The entry page is view-only: main process code pushes status snapshots one way, and it contains no preload, IPC bridge, renderer controls, or update choice. It renders the approved `daily`, `update`, `firstrun`, `offline`, `firstfail`, and `longrun` states; J-dev adds the `LOCAL BUILD · DEV` marker.

- **J1 first launch:** download the checksum-verified managed Node runtime, install Fleet Console latest, start it, and hand off.
- **J2 daily launch:** confirm the registry version, start the installed runtime, and hand off without user action.
- **J3 update:** automatically install a newly found version through the staging/rename transaction before starting Console.
- **J4 offline:** if the registry is unavailable, start a valid installed `latest` and retry the check next launch.
- **J5 attach:** adopt a healthy matching Desktop-owned Console immediately; bootstrap and update work are skipped.
- **J6 long-running shell:** poll every 60 minutes and on manual Check. The native message box offers **Update and Restart** or **Later** with **Skip this version**; it is shown at most once per version. Menu/tray retain `Update to x.x.x...` as the fallback after Later. Updating always calls `app.relaunch()` and reuses J3; there is no in-place update path.
- **J-dev:** `pnpm desktop` uses workspace Console `dist` and `FLEET_CONSOLE_NODE_PATH`/`npm_node_execpath`. It does not access `~/.fleet/desktop/runtime` or perform a registry check.

First-install failure **Retry**/**Quit** and J6 update prompts remain native. After the initial Console handoff, **Connect to Runtime…** opens a Desktop-owned local child modal with no JavaScript, accepts only literal `127.0.0.1:port`, verifies the read-only pairing identity, and transactionally loads that Console. Startup never treats a foreign Console as an implicit pairing request. Closing the window follows normal macOS behavior and hides to tray on Windows/Linux; a second launch restores the existing window.

## Development and packaging

Run these from the repository root:

```bash
pnpm --filter @dotobokuri/fleet-desktop typecheck
pnpm --filter @dotobokuri/fleet-desktop build
pnpm --filter @dotobokuri/fleet-desktop test
pnpm --filter @dotobokuri/fleet-desktop package:dir
pnpm --filter @dotobokuri/fleet-desktop package:unsigned
pnpm --filter @dotobokuri/fleet-desktop verify:package
```

`build` copies the entry and pairing HTML/CSS, pinned Node manifest, and icon into `dist`. `package:dir` is the credential-free local package check. `package:unsigned` produces local unsigned artifacts. `verify:package` requires a shell-only ASAR with entry assets and a Node manifest, while rejecting embedded Console/Node payloads, the legacy embedded runtime directory, updater metadata, and standalone blockmaps.

`package:release` is the only protected release path. It requires the platform signing credentials and fails closed when they are absent; its post-package verification checks release signing/notarization or checksum/GPG evidence. Local success is not release-signing evidence. Windows native package and live verification are [Unverified] on non-Windows hosts.

## Limits and troubleshooting

- **First install cannot finish:** the native dialog offers Retry or Quit only after staging cleanup; it never leaves a half-installed runtime.
- **Registry unavailable:** an installed `latest` remains usable. If none exists, Retry after connectivity is restored.
- **CLI-owned daemon exists:** do not delete a healthy lock or signal the process. Desktop only adopts a matching Desktop owner; connect to another runtime explicitly after normal startup.
- **A live foreign Console lock is unhealthy:** Desktop shows one warning, then exits. Stop or quit that Console before reopening Desktop; Desktop does not kill it. An owned sidecar that cannot terminate remains a normal startup failure.
- **Protocol is newer than the shell:** Desktop keeps the status passive and opens the Fleet releases page; it does not download a new shell automatically.
- **Provider unavailable:** start Desktop from an environment where the provider CLI is on `PATH`; Desktop does not provide provider discovery.
