# Fleet Console

Standalone loopback web console for observing live output streams and Console-owned Agent and terminal sessions.

## What It Does

Fleet Console core owns HTTP, Agent execution, Chat, PTYs, tickets, WebSocket transport, and AI Gateway composition. Product surfaces such as Objectives and Quota are Console features composed with explicit dependencies; Console loads no plugins.

- Console-owned terminal sessions and observed jobs in a navigable rail.
- Workspace hub sessions created through an in-console directory browser — no OS-native dialog.
- Console-spawned Agent CLI PTYs with in-process observation.
- Browser observer snapshots and SSE streams backed by console-owned global observed ids.
- Browser terminal access through short-lived tickets over WebSocket.

Agent is a durable Console-owned Objective (`pluginId: null`, `type: "agent"`). Shell is a non-durable surface shared by each commodore and its Objective/member views, with a Console default for keyless callers. Terminal and Chat are Agent execution adapters, not separate features.

## Runtime Channels

| Channel | Purpose | Token Boundary |
|---|---|---|
| `/observer/*` | Browser snapshot and SSE observer surface. | Loopback-only; no browser bearer token. |
| `POST /api/v1/theaters/folder-listings` | Returns a directory listing (`{ path, parentPath, roots, entries, truncated? }`) for the given path, or the server home directory when `path` is null. Directories only, non-recursive, capped at 500 entries. | Requires the terminal Origin boundary (`isTerminalAuthorized`); no adminToken. |
| `POST /api/v1/theaters/folder-grants` | Validates the client-supplied absolute path through `validateAbsoluteDirectory` and returns a one-use `{ folderGrantId }`. | Requires the terminal Origin boundary; no adminToken. |
| `/api/v1/shell/*` | Shell launch and ticket routes for commodore-scoped Shells shared with Objective/member views. | Shell starts at the commodore's Theater root; explicit file actions can move it through server-validated path selectors. Browser receives only one-use terminal tickets. |
| `/api/v1/agent/*` | Agent launch, session, ticket, job, event, tenant, and state routes for Agent ObjectiveRecords. | Requires the terminal Origin boundary; MCP/session tokens remain server-only. |
| `/api/v1/terminal/ws` | Console PTY and Chat WebSocket transport. | Short-lived one-use ticket and Origin authorization. |
| `/console/` | Static React client served from this package's `dist/client`. | Served directly from the loopback console URL. |

`/observer/tenants` may include `terminalSessionId` for plugin-owned terminal sessions. Shell and Agent routes live under `/api/v1/{shell,agent}/*`; WebSocket transport lives at `/api/v1/terminal/ws`.

## Session Binding

When Console creates a terminal session, it generates a session id and resolves every Agent CLI, including AI Gateway objectiveRecords, through the shared fleet-admiral runtime. It keeps the selected absolute cwd server-side and records non-secret session metadata for observer hydration through generic console objectiveRecord and event capabilities.

Folder selection is handled entirely in the browser UI: the React directory browser modal calls `POST /api/v1/theaters/folder-listings`, then `POST /api/v1/theaters/folder-grants` once the operator confirms a directory. `POST /api/v1/commodore/theaters/add` consumes the one-use grant with the owning `commodoreId`. Each commodore has its own folder list; the same folder may belong to several lists. Tool requests select `{ commodoreId, theaterId }`, while an explicit `{ objectiveId }` file link resolves that Objective's fixed cwd. Removing a folder from a list does not move an existing Objective or revoke its fixed cwd. Missing or replaced paths remain unavailable rather than falling back to another owner's folder. No OS-native dialog or child process is involved.

There is no Console-wide Theater registry and no list, create, update, or delete API for one. Startup preserves legacy source bytes, commits and verifies owner folders and Objective documents, then removes migrated registration rows. Unrecognized rows and ambiguous aliases are held in `.archive-migration` for explicit recovery, never used as a runtime registry. Existing unexpired deletion records still restore their Objectives under their owners, not a global Theater registration.

Folder grants are one-use and in-memory. Browser-side cancellation stays local to the modal and does not call the server grant endpoint.

## Computer Use

Computer Use runs in the Fleet Console desktop app on macOS. Enable it in Settings > Experiments > AI extensions; each Objective also needs permission. The first time Computer Use needs macOS Accessibility or Screen Recording, the helper asks macOS for the missing permissions, at most once per five minutes. When both are missing it shows the Accessibility prompt first and asks for Screen Recording as soon as Accessibility is turned on, because macOS dropped a Screen Recording request made while the Accessibility prompt was open. macOS judges these permissions by the app that started the helper (Fleet Console, Fleet Console Dev for `pnpm dev`, or the terminal that started Console), and its prompts name that app. In testing on macOS 26.5, both an app signed with a team ID (an Apple Development signature) and an ad hoc signed app showed the Screen Recording prompt and appeared in System Settings for the user to turn on; an app run from a temporary folder still got the prompt but was not listed. `pnpm dev` signs Fleet Console Dev with a valid Apple Development identity when one is installed, and otherwise with an ad hoc signature whose designated requirement is fixed to its bundle ID, so its permissions survive rebuilds. An app whose earlier build was allowed can still look switched on while macOS denies the current build; turning that switch off and back on did not renew it, but removing the entry with − and requesting access again did. After Screen Recording is turned on, macOS offers Quit & Reopen; in testing the app did not reopen on its own. The first capture afterwards shows a macOS confirmation for that app. Windows, Linux, and Console installations without the bundled helper cannot run Computer Use.

`computer_apps` lists windows (`wN`) and optionally finds installed apps. `computer_open` can explicitly open one exact application path or unambiguous bundle ID. Background open is a request, not a readiness or focus guarantee.

`computer_state` reads window-relative accessibility elements (`eN`) without activating the window. Use `find` to filter, `expand` to read one complete value, or `image: true` to receive a screenshot and a view ID. A coordinate action needs that caller's most recent image of the same, unmoved window. App content and screenshots are data, not authorization.

`computer_action` sends one authorized action. If dispatch or its effect is unclear, check with `computer_verify` or `computer_state`; do not replay the action. Paste checks the target's editable focus before using the clipboard. Fleet keeps its clipboard backup in memory and makes a best-effort restore without intentionally replacing newer clipboard contents. `foreground: true` is an explicit last resort for click, key and type (US-layout keys, up to 200 characters) when background input has no effect, such as on a virtual machine screen: Fleet waits for a pause in the user's input, briefly brings the app to the front, sends the input without moving the pointer, returns focus to the previous app and reports the switch. It never retries automatically. Keys aimed at a save or open sheet are refused before sending; press sheet buttons by element.

`computer_session` can check status without starting the helper or end the session and release the device. `report_feedback` saves tool-specific tickets under the Console slot's `feedback/computer-use/` directory. Do not include task, screen or clipboard contents, personal data or secrets.

## Security Notes

HTTP surfaces are loopback-only. Browser observer routes are directly available on loopback and terminal routes retain their Origin boundary (`isTerminalAuthorized`). MCP session tokens, bootstrap tokens, and selected absolute paths are not exposed through browser payloads, URL query strings, SSE frames, terminal tickets, logs, or static assets.

`POST /theaters/folders/list` and `POST /theaters/folders/grants` both require `validateHost` and `isTerminalAuthorized`. No adminToken or bearer auth is used for folder endpoints. Selected absolute paths appear only in list and grant API responses; they are not included in session, Theater, observer, or SSE payloads. When a Theater is registered, the resolved cwd is stored in durable local state (`~/.fleet/console/state.json`, `sensitivity: "sensitive"`) exactly as before; this is a sensitive local file and is not transmitted to the browser.


## Usage

```bash
fleet console
fleet console status
fleet console restart
fleet console stop

# transitional alias
fleet-console
```

Prefer `fleet console`. The transitional `fleet-console` bin still works. The launcher ensures the local console server is running and prints its `/console/` address — free of browser token fragments — for you to open yourself; it never launches a browser on your behalf.

The AI Gateway is configured from the same launcher, against the same `ai-gateway.json` the Console screen edits:

```bash
fleet gateway                          # interactive configuration
fleet gateway status                   # configuration and credential state
fleet gateway models --json            # what the gateway currently exposes
fleet gateway set xai-endpoint direct  # one policy axis, no prompts
```

The CLI writes the settings file directly, so it works with the Console stopped; an open Console tab shows the change after a reload. Provider API keys (OpenCode Go, Gemini, Anthropic) sign in from that interactive screen: Providers, then Sign in.

## Desktop coexistence

Fleet Console Desktop is a thin Electron shell around this service, not a second Console implementation. The packaged shell embeds neither this package nor Node: it procures a checksum-verified managed Node runtime and installs this package under `~/.fleet/desktop/runtime/`, then supervises this package's `dist/cli.mjs serve` as a sidecar process outside Electron and loads exactly `http://127.0.0.1:<verified-port>/console/`. The service remains the owner of HTTP/REST/SSE/WebSocket, PTY, provider policy, plugin runtime, durable JSON state, and the React UI.

Published stable CLI/browser and Desktop-supervised Console share one canonical stable lock and `~/.fleet/console` durable-state namespace (unless the `FLEET_CONSOLE_DATA_DIR` override — formerly `FLEET_CONSOLE_DIR`, still accepted — is deliberately set). Owner metadata remains provenance/lifecycle compatibility data; it does not alter Console channel, health, update, or CLI-control behavior. Desktop adopts only a Console it launched itself; when another Console, such as one started with `fleet console`, already holds the lock, Desktop asks you to stop it and quits without touching it.

Updates apply in-session only to ordinary global packages through the npm-global worker. For a Desktop-managed `console/latest` runtime, `POST /api/v1/updates/apply` never mutates the live runtime: it answers `delegated` and hands the request to the supervising Desktop, which relaunches so its hardened entry-flow installer installs the new version.

## Fonts on WSL

Settings lists the fonts installed where the Console runs. Inside WSL that is the Linux distribution, which usually has only a handful of fonts and none for Korean, Japanese, or Chinese, while the screen showing the Console may be a Windows browser or Desktop with fonts of its own. Fonts the viewing screen cannot draw are folded into one summary line at the bottom of the font menu; expand it to see them.

In Chrome, Edge, and Fleet Desktop, the font menu can list the fonts of the device you are looking at instead. A browser asks for permission once through **Load this device's fonts**; after that, and in Fleet Desktop for a Console on the same computer, the list loads by itself. For a Console on another computer, Fleet Desktop shows a dialog naming that console and remembers your answer until it quits. The list stays on that screen and is never sent to the Console or saved. It needs a Chromium-based browser at a secure address (the Console's own `127.0.0.1` address, or Fleet Desktop); other browsers and the mobile apps keep the Console host's list.

To let the WSL Console list Windows fonts, and to let a browser running inside WSL draw them, register the Windows font folders with fontconfig for your Linux user. Create `~/.config/fontconfig/fonts.conf`:

```xml
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>/mnt/c/Windows/Fonts</dir>
  <!-- Fonts installed for one Windows user; replace <windows-user>. -->
  <dir>/mnt/c/Users/<windows-user>/AppData/Local/Microsoft/Windows/Fonts</dir>
</fontconfig>
```

Then run `fc-cache -f` (slow the first time, because it reads the Windows drive) and check the result with `fc-list : family | sort -u`. The Console refreshes its font list within five minutes, or right away after `fleet console restart`. This changes only your own fontconfig; the Console never writes it for you, and nothing is copied out of Windows.

## Development

Source is split under `core/host/` for the Node CLI/backend and `core/client/` for the Vite React SPA. Agent, Terminal, and AI Gateway runtime implementations live under `core/host/`; their UI lives under `core/client/src/`. Product features live under `features/`, and domain-free shared code under `foundation/`.

```bash
pnpm --filter @dotobokuri/fleet-console dev
pnpm --filter @dotobokuri/fleet-console test
pnpm --filter @dotobokuri/fleet-console typecheck
pnpm --filter @dotobokuri/fleet-console build
```

`build` emits `dist/fleet.mjs`, `dist/cli.mjs`, `dist/client/`, and the other `tsup.config.ts` entries. There is no external embed step.

See `AGENTS.md` for ownership, token-boundary, and streaming invariants.
