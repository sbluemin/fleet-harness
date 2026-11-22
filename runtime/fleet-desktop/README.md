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

Console data remains in `~/.fleet/console`: durable state, captures, and lock files keep their existing ownership and semantics. `FLEET_CONSOLE_DATA_DIR` is the explicit operator/test override (`FLEET_CONSOLE_DIR` is its former name, still accepted from packaged shells), and `FLEET_DESKTOP_DATA_DIR` relocates Desktop's own owner identity and user data. `pnpm desktop` sets both, plus the `FLEET_DATA_DIR` root, to a checkout-local isolated slot. Desktop never copies Console service, React UI, PTY, provider, plugin, or durable-state behavior into Electron.

## Startup journeys

The entry page is view-only: main process code pushes status snapshots one way, and it contains no preload, IPC bridge, renderer controls, or update choice. It renders the approved `daily`, `update`, `firstrun`, `offline`, `firstfail`, and `longrun` states; J-dev adds the `LOCAL BUILD · DEV` marker.

- **J1 first launch:** download the checksum-verified managed Node runtime, install Fleet Console latest, start it, and hand off.
- **J2 daily launch:** confirm the registry version, start the installed runtime, and hand off without user action.
- **J3 update:** automatically install a newly found version through the staging/rename transaction before starting Console.
- **J4 offline:** if the registry is unavailable, start a valid installed `latest` and retry the check next launch.
- **J5 attach:** adopt a healthy matching Desktop-owned Console immediately; bootstrap and update work are skipped.
- **J6 long-running shell:** the shell checks GitHub Releases for a newer Desktop at startup and every 60 minutes; the interval is fixed. Nothing is fetched in the background. Console announces a found version inside the window, on the help button, and the same state appears as `Check for Updates`, `Download Update x.x.x…`, and `Restart to Update to x.x.x` in the macOS app menu or the Windows tray. The download starts only when you ask for it, and nothing restarts until you choose Restart; the installer then replaces and relaunches the shell. If the local managed Console also has an update waiting, that relaunch installs it through J3. A Console-only update requested in the window relaunches the app into J3; there is no in-place update of a managed runtime. Shell self-update covers the macOS and Windows releases; Linux is not covered.
- **J-dev:** `pnpm desktop` uses workspace Console `dist` and `FLEET_CONSOLE_NODE_PATH`/`npm_node_execpath`. It does not access `~/.fleet/desktop/runtime` or perform a registry check.

First-install failure **Retry**/**Quit** remains a native dialog; update notices never open a native dialog or tray balloon. Desktop offers no surface of its own for choosing, adding, or naming a Console; that list belongs to Fleet Console. Startup never treats a foreign Console as an implicit pairing request. Closing the window follows normal macOS behavior and hides to tray on Windows/Linux; a second launch restores the existing window.

## Reaching another console

Which consoles this machine can reach is Fleet Console's list, not Desktop's. Desktop contributes only the plumbing a browser cannot do:

- It registers the `fleet://` scheme and forwards the raw argument to the local Console without parsing it.
- Before the window sees a remote origin, it confirms that origin's live certificate against the fingerprint the local Console holds for it, over a plain socket first, because Chromium caches a failed verdict for the whole app run.
- It admits that one origin, exchanges the single-use grant in a main-process request body, and loads `/console/` there. The URL the renderer loads stays token-free.

Desktop stores no host and keeps no credential. Withdrawing an origin also clears it from navigation, and a certificate pin narrows trust to one host without widening it for any other.

Managed remote runtimes over SSH were removed: Desktop no longer installs or supervises Node and Console on another machine. Run Fleet Console on that machine and add it here with its access link.

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

macOS 개발 실행은 `pnpm desktop` 또는 `pnpm --filter @dotobokuri/fleet-desktop dev`를 사용합니다. 실행 없이 개발 앱을 만들려면 `pnpm --filter @dotobokuri/fleet-desktop build:dev`를 사용합니다. 생성 위치는 `runtime/fleet-desktop/.stage/dev-app/Fleet Console Dev.app`이며, 파일명·번들 이름·실행 이름은 `Fleet Console Dev`, Bundle ID는 `com.dotobokuri.fleet-console.dev`입니다. 릴리스 앱과 별도의 macOS 권한 항목을 사용하고 `fleet://` 기본 앱 등록은 하지 않습니다. 화면 기록·접근성 권한이 필요하면 이 개발 앱을 별도로 허용하세요. 개발 wrapper와 개발 Computer Use 헬퍼는 `FLEET_DEV_CODESIGN_IDENTITY`(ID 해시나 이름, `-`이면 ad hoc) → 키체인의 유효한 Apple Development ID → ad hoc 순서로 고른 ID로 서명되며, 재사용 시 서명된 내용을 변경하지 않습니다. 고른 ID가 바뀌면 wrapper를 다시 서명합니다. 팀 ID로 서명하면 지정 요구 조건이 그 인증서에 묶이고, ad hoc이면 wrapper의 지정 요구 조건을 Bundle ID로 고정합니다(`designated => identifier "com.dotobokuri.fleet-console.dev"`). 어느 쪽이든 macOS가 손쉬운 사용·화면 기록을 요청 창으로 묻고 시스템 설정 목록에 올리며, 허용이 Electron 교체나 wrapper 재생성 뒤에도 유지됩니다. 처음 서명할 때 키체인이 codesign의 키 사용을 물을 수 있습니다. Bundle ID 고정 요구 조건은 같은 Mac에서 같은 Bundle ID로 ad hoc 서명한 다른 코드도 만족하므로, 유효한 Apple Development ID가 있으면 그쪽으로 서명합니다. 이전 ad hoc wrapper(cdhash 요구 조건)에 준 허용은 목록에서 켜져 있어도 거부될 수 있고, 껐다 켜기로는 되살아나지 않았습니다. 그때는 그 항목을 −로 빼고 Fleet에서 다시 요청한 뒤 목록에 나타나면 켜 주세요. 앱이 temp 폴더(`/private/tmp` 등)에 있으면 macOS가 요청 창을 띄워도 시스템 설정 목록에는 나타나지 않습니다. 실행은 workspace 경로를 전달하는 개발 스크립트로 수행합니다. Windows/Linux의 `build:dev`는 번들만 빌드하며 macOS `.app`을 만들지 않습니다.

`build` copies the entry assets, pinned Node manifest, and icon into `dist`. `package:dir` is the credential-free local package check. `package:unsigned` produces local unsigned artifacts. `verify:package` requires a shell-only ASAR with entry assets and a Node manifest, while rejecting embedded Console/Node payloads and the legacy embedded runtime directory. Release verification additionally requires the updater metadata the shell needs to replace itself.

`package:release` is the only protected release path. It requires the platform signing credentials and fails closed when they are absent; its post-package verification checks release signing/notarization or checksum/GPG evidence. Local success is not release-signing evidence. Windows native package and live verification are [Unverified] on non-Windows hosts.

## Computer Use

The macOS app ships Fleet's Swift helper inside `Contents/Helpers/Fleet Computer Use.app`. Console starts the helper directly under the desktop app's responsibility and checks Accessibility, Screen Recording, and background input before sending actions. If the self-check fails, observation remains available but app control pauses. Windows and Linux do not support Computer Use.

Agents use the MCP tools to read exact windows, act in the background, and verify the result. An action is never replayed to recover an uncertain outcome. An AI cursor shows where Fleet acts without taking over the user's pointer. The optional Desktop live preview uses only the selected window, runs locally, and ends with the device session; it is not a recording.

## Limits and troubleshooting

- **First install cannot finish:** the native dialog offers Retry or Quit only after staging cleanup; it never leaves a half-installed runtime.
- **Registry unavailable:** an installed `latest` remains usable. If none exists, Retry after connectivity is restored.
- **CLI-owned daemon exists:** do not delete a healthy lock or signal the process. Desktop only adopts a matching Desktop owner; reach another console from Fleet Console's own host list after normal startup.
- **A live foreign Console lock is unhealthy:** Desktop shows one warning, then exits. Stop or quit that Console before reopening Desktop; Desktop does not kill it. An owned sidecar that cannot terminate remains a normal startup failure.
- **Console's lock file is in the way:** when the lock cannot be read, belongs to another user, or another start holds it, Desktop shows what holds it and how to clear it by hand, then exits. It leaves the lock in place. A lock left by a crashed Console is reclaimed by the Console Desktop starts. See [Console Lock Reclaim Across Hosts](../../docs/console-lock-reclaim.md) for the rules, the mixed-release limits, and the legacy handling of runtimes up to 1.212.0.
- **Console needs a newer runtime than the shell ships:** Desktop shows a native error asking you to install the latest Fleet Console Desktop release, then exits; it never starts Console on a mismatched Node runtime.
- **Provider unavailable:** start Desktop from an environment where the provider CLI is on `PATH`; Desktop does not provide provider discovery.
