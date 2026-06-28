# Fleet Console Doctrine

`runtime/fleet-console` owns the Fleet Console — a standalone fullstack product: its own loopback HTTP backend plus the React web surface for observing carrier jobs, live output streams from console-owned terminal sessions, and the Codex/Fleet Wiki web surface, driven by the `fleet-console` CLI lifecycle. It is the unified Fleet GUI runtime.

## Owns

- The console HTTP backend (loopback-only): its own server skeleton, security headers, static `/console/` serving of its own `dist/client/`, the browser observer REST/SSE surface (including the `validateHost`-gated `GET /observer/api-catalog` route-catalog introspection that backs the Settings backend-API list), generic plugin route/upgrade registration, and console-owned Theater folder selection. The console no longer imports or launches the retired gateway package.
- The server lifecycle: lock file, runtime paths, health probe, and build-stale detection are console-owned. `fleet-console` is the daemon, not a launcher over someone else's daemon.
- The `fleet-console` CLI entry point (`./cli` export, `dist/cli.mjs`): `start` (the default when no subcommand is given) ensures the local console server and opens the console URL in a browser; if a healthy daemon already exists, it opens that daemon's URL without starting a new server or erroring. `stop` stops the console server; `restart` stops the console server then starts a fresh one and opens it; `status` prints server health, endpoint, console URL, and registered-workspace count. The server binds to an OS-assigned random loopback port and records the actual port in the lock file, so consumers discover the port from the lock endpoint. `--help`/`-h` prints the banner-style help. `fleet console <args>` in `fleet-cli` relays the full argument list to this CLI as a child process, so every subcommand works through both `fleet console …` and the standalone `fleet-console …` binary. The root `pnpm fleet-console` script runs it from source via `tsx`; unpublished local runs isolate runtime files under the project workspace `.fleet/console` unless `FLEET_CONSOLE_DIR` is set, while published stable builds continue using the OS temp directory.
- Terminal sessions are spawned server-side by the Terminal plugin and observed in-process; carrier events flow directly into the observer store and browser SSE without a separate fleet-cli registration channel.
- Console durable state is persisted in the console data directory's `state.json` (`createDurableJsonStore`, `sensitivity: "sensitive"`). The data directory follows the release channel: published stable builds use `~/.fleet/console/state.json`, while unpublished local runs (`pnpm fleet-console`/`tsx`) use the project workspace `.fleet/console/state.json` co-located with the lock, so a dev console never shares Theaters/Operations with a globally installed one. Setting `FLEET_CONSOLE_DIR` relocates the durable state (and captures) into that directory too — co-located with the lock, matching the runtime-file escape hatch — so a read-only checkout can point its writable runtime slot away from the project tree. The console server is the sole writer; the file stores `{ version: 1, theaters, operations }`. On startup the server restores Theaters and Operations into a dormant state (no PTY), and Operation state survives console restarts. Each Operation also records whether its label came from the operator or from automatic naming (`labelSource`), so the prompt-derived auto-name never overwrites a manual rename.
- A capture inbound channel writes `{fleetSessionId}.json` under the same console data directory's `captures/` (`~/.fleet/console/captures/` for stable, the project `.fleet/console/captures/` for local runs). Provider CLI SessionStart hooks record provider session ids via `fleet-console hook capture-session <provider>`; the server reads the capture file, merges the provider session id into durable state, and cleans up the capture file. This is separate from the console lock file in `os.tmpdir()` (stable) / the project `.fleet/console` lock (local).
- The React SPA served from the console backend at `/console/`: layout, components, styles, and visual identity. The global navigation bar owns **Theater** selection — a project root directory that groups console-owned terminal sessions and Codex wiki context. The Operations surface renders a single spatial Map canvas of terminal sessions filtered to the active Theater; operators create sessions directly on the canvas (Shift-drag or right-click), choosing an Agent CLI before a new terminal session starts. Each session panel lists its active carrier jobs in a floating job dock, and selecting a job opens a centered streaming overlay scoped to that session's jobs. The canvas also hosts free shell panels (right-click) that resolve their cwd from the active Theater. A console-wide Operation quick-search (Cmd/Ctrl+K) searches terminal sessions across all Theaters, switches to the selected Operation's Theater, selects that Operation, and navigates to `/operations`; on `/codex` paths the same shortcut yields to Codex's own search.
- The built-in Terminal plugin (`runtime/fleet-plugins/terminal`, package `@fleet-plugins/terminal`): one plugin id, `terminal`, owns the Shell and Agent operation kinds plus plugin-scoped WebSocket, ticket registry, PTY session lifecycle, and launch runtime. It absorbs the server-shared and client-shared helpers, keeps operation type ids `shell` and `agent` (carrier streaming renders inside the Agent panel as an in-panel summary plus a detail modal, not a separate child operation), serves plugin HTTP routes under `/plugins/terminal/{shell,agent}/*`, and uses the plugin-scoped `ws` route for PTY transport. The Shell launch label is `Shell`.
- The Codex/Fleet Wiki web surface under `/console/codex`: the console-owned Codex server gateway, workspace registry, wiki API routes, and migrated vanilla TypeScript Maritime Codex client. The console-level **TheaterRegistry** is the source of truth for project roots and does not require a Fleet Wiki knowledge root; the Codex `WorkspaceRegistry` is the subset of Theaters whose directories contain a Fleet Wiki knowledge root. Codex is mounted as a Right Rail built-in panel under the Fleet Console GNB without an iframe or proxy daemon.
- The observer-side client contract: REST snapshot fetches and the SSE consumption loop with reconnect/resync.
- The streaming view model: the event reducer that folds `CarrierJobStreamEvent` timelines into per-job, per-track views with incremental text accumulation.
- Console self-update (`POST /update/apply`): the console backend owns an independent detached self-update worker that re-installs the globally published `fleet-cli` and `fleet-console` packages, writes a status file and a log file under the console data directory, and blocks the request while any active terminal session is live. The route enforces exact loopback Origin, rejects local/unpublished builds, re-checks the latest release before accepting, and returns `202 { status: "accepted" }` only after the worker has been spawned and detached. The worker shuts down the console server and re-opens a browser on the new server at a fresh OS-assigned random loopback port once the install completes; the old tab is intentionally not preserved. Console must never import or depend on `@dotobokuri/fleet-cli` for this flow.

## Codex / Fleet Wiki Surface

- Canonical Codex workspace routes live under `/console/codex/w/:ws/...`; MRU-compatible API routes live under `/console/codex/api/...`. Do not reintroduce global `/api/...` wiki routes because console owns its own local API namespace. The Codex server exposes exactly 4 REST resources: `GET /api/search` (empty `q` = full index via `listWiki`; non-empty `q` = `briefingQuery`), `GET /api/entry/:id` (with optional `?include=raw` to embed raw source content inline — raw is never served as a separate endpoint), `GET|POST /api/drydock[/:id[/decision]]` (replaces the former `/api/queue*` surface; all queue actions now go through `drydock/:id/decision`), and `GET /api/conflicts[/:id]`. All deprecated paths — `/api/health`, `/api/workspaces`, `/api/index`, `/api/index-md`, `/api/log`, `/api/raw`, and `/api/queue*` — return 404 or 405 and must not be reintroduced.
- The console-level **Theater** is the parent concept for project roots. Codex workspaces share the same id space (`workspaceHash(realpath(dir))`) but are a strict subset of the Theater registry (`hasWiki=true`). The Codex left workspace switcher is removed; Theater selection in the global navigation bar is the only workspace switch, and Theaters without a Fleet Wiki knowledge root render a "Codex 없음" state instead of mounting a wiki surface.
- The migrated Codex client stays Vanilla TypeScript under `core/client/src/codex/**`; do not rewrite it into React state or components beyond the React mount host.
- Codex is a **Right Rail built-in panel** (after ALERTS; `BUILT_IN_RAIL_PANELS = [alertsPanel, codexPanel]`). The rail renders a single-column **Navigator** (search input + entry list + Drydock pending-count badge + Conflicts entry) — there is no `app-shell` 3-pane grid, container-responsive pane-shedding, or pane-collapse toggle. A single shared mount host (`codex-host.ts`) relocates the Vanilla singleton into the rail container with `appendChild` via `mountNavigatorInto` + a `setOnRequestOpenReader` callback + `setNavigatorTheater`; `destroy()`+remount is never called. Workspace selection is driven by Theater state (`ctx.theaterId` from `RailPanelContext`); the left workspace switcher is removed. Mount paths: Theater auto-registration (`server.ts` `codex.registerWorkspace(cwd)`) and restart restoration (`server.ts` `restoreCodexWorkspaces`). The admin workspace registration endpoint, bearer-token surface, standalone `fleet-wiki` binary, Vanilla `router.ts`, `setCodexPresentationMode`/`setCodexPaneCollapsed`, and the `fleet-console.codex.nav-collapsed`/`rail-collapsed` localStorage keys are all removed.
- The Codex reading surface has two tiers. Selecting a Navigator entry opens an **inline 2-pane split** inside the rail panel: the rail slot widens (the user's nav width + a ~360px document pane, driven by `useCodexSplitExtraWidth` reading `codexReader` state) and renders the preserved markdown reader on the **left** (`.codex-doc-pane`, ~46ch measure, with a collapsible inline ToC and a compact `⤢ Expand` button) while the Navigator stays on the **right** (`.codex-nav-pane`, still browsable — selecting another entry swaps the left document). The `⤢ Expand` button opens the **Reading overlay** (`CodexReadingSheet`, `createPortal` to `document.body`) — a centered modal "large view" over the Operations canvas at a fixed comfortable width (`min(960px, calc(100vw - 120px))`, no width toggle), gated on `codexReader != null && codexReaderExpanded`. The overlay is `role="dialog"` + `aria-modal="true"`, focus-trapped, animated with `codex-rise-centered` (which preserves the base `translateX(-50%)` centering — plain `codex-rise` sets only `translateY` and would clobber it), marks the background canvas/SideBar inert via `body[data-codex-reading]`, carries a 200px ToC rail with an `IntersectionObserver` scroll-spy (brass = active section), and closes on Esc/scrim/✕ back to the **2-pane split** (not nav-only) with focus restored to the Expand button. A single Vanilla reader instance (`codex-host` `readerHostNode`/`tocHostNode`) relocates between the split doc-pane and the overlay via `appendChild`, preserving content and scroll. The reading measure is owned by `.markdown-body` and its reading-wrapper siblings (`.document-header`, `.related-list`), never a shell grid. Codex typography is tokenized through `--font-size-*`; brass = active/location and aurora = live/link semantics, glass surfaces, self-hosted Fraunces/Manrope/JetBrains Mono, and `prefers-reduced-motion` short-circuits are unchanged. The deprecated `app-shell`/`app-shell--wide`/`app-shell--raw` grid, container queries, document-level ToC drawer, Manifest panel, `⌘\`/`Ctrl+\` width toggle, `.codex-reading-sheet.is-wide`, and the `Esc · ⌘\` hint are removed.
- Preserve Maritime Codex reading aesthetic: the markdown render pipeline (`renderMarkdown` — marked + DOMPurify + hljs + wiki links; `diagrams.ts` Mermaid `securityLevel: "strict"`) and the `.markdown-body`/`.document-header`/`.related-list`/`.code-block` styling are preserved verbatim and reused in both the inline split doc-pane and the Reading overlay. Surfaces: Navigator (search + entry list + Drydock + conflicts), the inline 2-pane split (document + browsable navigator), and the Reading overlay (large markdown view + ToC scroll-spy + copy-context actions + diagram lightbox), with brass/aurora roles and self-hosted fonts. The standalone raw viewer route, index/log views, command palette, Manifest panel, and document-level ToC drawer are removed; raw source is embedded inline via `GET /api/entry/:id?include=raw`.
- Preserve wiki security invariants: Host allowlist, Origin guard, write-surface loopback gate, DOMPurify markdown sanitization, Mermaid `securityLevel: "strict"` with `htmlLabels: false` and no `bindFunctions`, path containment, and lockfile bearer auth for admin workspace registration.
- Browser payloads must not expose MCP/session tokens, terminal tickets, or Codex admin tokens.

## Must Not Own

- Multi-tenant aggregation or tenant/session token issuance — the console observes local console-owned terminal sessions; it does not re-implement the retired gateway tenant model.
- Browser-facing MCP transport or MCP proxying. Console server-side terminal sessions may create per-session Fleet MCP runtimes and executor session tokens only through `@dotobokuri/fleet-admiral`; tokens remain server-only and must never reach browser payloads, tickets, logs, URLs, or static assets.
- Fleet tool builders, carrier persona policy, or provider-specific launch/resume/hook logic. Console may consume the `@dotobokuri/fleet-admiral` root launch/runtime API (including public hooks such as `createSessionCaptureHookExec`) but must not copy, fork, or deep-import provider-specific launch builders, resume argument renderers, or hook renderers.

## Token Boundary (hard rule)

- Browser observer routes are loopback-only and do not use browser bearer tokens.
- Terminal HTTP routes do not use browser bearer tokens, but must retain the terminal Origin check; the terminal WebSocket is reached through a one-use ticket.
- MCP session tokens must never reach browser code, URL query strings, SSE payloads, terminal tickets, logs, or static assets.
- Theater routes likewise do not expose admin bearer tokens, MCP/session tokens, terminal tickets, folder-grant identifiers, raw working-directory paths, provider session ids, or transcript paths to the browser.
- Console-owned Theater folder browser routes (`POST /theaters/folders/list`, `POST /theaters/folders/grants`) are gated by `validateHost` then `isTerminalAuthorized` (the same Origin boundary as terminal routes). No adminToken or bearer auth is added. Folder selection is browser UI plus loopback fs APIs; no OS-native dialog or child process is spawned. Selected absolute paths appear only in list and grant responses; they are not included in session, Theater, observer, or SSE payloads. When a Theater is registered the resolved cwd is stored in durable local state (`sensitivity: "sensitive"`) as before — it is not transmitted to the browser.
- **Symlink containment** — Theater file/image routes must verify containment _after_ resolving symlinks: call `fs.promises.realpath()` on both the target path and the Theater root, then re-check that the real path is within the real root before stat/read. Symptom without this: a symlink inside the Theater can point to `/etc/passwd` and pass the initial string-prefix check. Why: `path.resolve` + string prefix only catches traversal in the nominal path; `realpath` follows the actual OS link chain.
- **Git ref option injection** — Any `ref` string passed to Theater diff routes must be validated against `isSafeGitRef()` (SHA or branch/tag — no leading `-`). Even with `shell: false`, git options like `--output=` or `--no-index` are interpreted by git as flags when passed as ref arguments. Symptom without this: a crafted `ref` can redirect git output or trigger unintended git operations. Why: git parses its own argv before the shell; format whitelisting is the only reliable guard.

## Carrier Readiness/Settings Boundary

- `runtime/fleet-console/core/host/**` may import `@dotobokuri/fleet-carriers` public root exports to consume Carrier Readiness read models and mutate global Carrier Settings through the carrier store.
- `runtime/fleet-console/core/client/**` must not import `@dotobokuri/fleet-carriers`, carrier persona modules, deep carrier paths, or Node-only carrier runtime modules.
- Fleet Console may render and edit display-safe carrier settings data such as carrier id, display name, role/category, resolved CLI/model/effort, Task Force backend count/configuration, and subagent mode/tag.
- `fleet-carriers` remains the source of truth for carrier persona defaults, carrier-store interpretation, store mutation, and carrier read-model construction. Console must not copy or reconstruct carrier persona policy or carrier runtime state.
- Console must not deep-import `@dotobokuri/fleet-carriers/src/**`, `packages/fleet-carriers/src/**`, `runtime/fleet-cli/**`, or `@dotobokuri/fleet-cli`.
- Carrier readiness/settings browser payloads must not serialize prompt bodies, raw persona instructions, executor tool allowlists, tokens, credential values, auth env details, terminal/session/admin tickets, or raw filesystem paths.

## Settings Plugin Boundary

- Core Settings owns the `Console` group and core console settings such as the console port controls.
- Model sign-in settings are Terminal plugin-owned, not core-owned.
- Plugin Settings sections are discovered from `plugins[].settingsSections` and rendered under the `Plugins` group. The host derives plugin ownership from the plugin registration id and normalizes plugin active ids as `${pluginId}:${sectionId}`.
- SDK settings descriptors remain minimal: `{ id, title, render }`. Do not add grouping, ordering, plugin ownership, or sensitivity metadata to `SettingsSectionDescriptor`.

## Server-side Dependency Boundary

- `runtime/fleet-console/core/host/**` may import `@dotobokuri/fleet-admiral` public root exports for server-only Agent CLI launch/runtime assembly. `runtime/fleet-console/core/client/**` must not import `@dotobokuri/fleet-admiral`.
- Fleet Console core host, core client, and built-in plugins may import `@fleet-console/sdk` domain subpaths. The SDK is the plugin-facing contract SSoT and must not import back from core, `@dotobokuri/*`, or `@fleet-plugins/*`.

## External Client Plugins

Fleet Console can load third-party client plugins from `~/.fleet/plugins/<id>/` alongside the built-in Terminal plugin. Built-in plugins remain statically resolved through `virtual:fleet-plugins`; only external plugins are discovered and loaded at runtime.

### Discovery & Manifest

- External plugins are discovered under `~/.fleet/plugins/<id>/`. Each plugin directory must contain a `plugin.json` manifest.
- Required and optional manifest fields:
  - `id` (required): plugin identifier, must match `^[a-z0-9][a-z0-9-]*$`.
  - `name?`: human-readable plugin name.
  - `apiVersion?`: integer major version. External plugins must match the console SDK major version (`SDK_API_VERSION`); a mismatch causes the plugin to be hard-skipped.
  - `client?`: relative path to the browser client entry (e.g. `client/index.tsx`).
  - `routes?`: relative path to the Node server route module (e.g. `routes.ts`).
  - `sensitiveFields?`: list of operation payload fields the plugin considers sensitive; these augment core sanitization for observer responses.
- Plugin entry paths are validated to stay within the plugin root; absolute paths or `..` segments are rejected.

### Server Runtime Routes

- Core owns three dedicated routes under `/plugin-runtime/`:
  - `GET /plugin-runtime/manifest` returns the external-plugin catalog DTO `{ plugins: { id, name?, clientUrl, apiVersion }[] }`.
  - `GET /plugin-runtime/client/<id>.mjs` serves the bundled external plugin client.
  - `GET /plugin-runtime/shim/<name>.mjs` serves React/SDK shims that re-export the console runtime singleton.
- These routes are intentionally **not** under `/plugins/` or `/console/` to avoid overlap with plugin-scoped routes and static fallback handling.
- External route modules (`.ts`) are bundled with esbuild into temporary ESM bundles; plain `.mjs`/`.js` files are served directly. `react`, `react/jsx-runtime`, `@fleet-console/sdk/*`, `@dotobokuri/*`, `@fleet-plugins/*`, and Node built-ins are external for server route bundles.

### Client Loading & Singleton Runtime

- `main.tsx` publishes the console's own React and SDK browser modules to `globalThis.__fleetConsoleRuntime__` before render.
- Shim modules served from `/plugin-runtime/shim/<name>.mjs` read that global object and re-export the same React/SDK instances, so external plugins share the console's React singleton and avoid dual-React errors.
- External plugin client sources (`.ts`/`.tsx`) are bundled with esbuild at server startup. `react`, `react/jsx-runtime`, and all `@fleet-console/sdk/*` specifiers are rewritten to shim URLs; import maps are not used.
- During bootstrap `loadPluginRegistry()` fetches `/plugin-runtime/manifest`, dynamically imports each listed client module, and merges the resulting `operationKinds`, `settingsSections`, and `notificationKinds` into the client plugin registry.

### Trust Model

- **Installing an external plugin equals trusting it.** External plugins run with the same privileges as the console host process on loopback and share the browser origin. This is the same trust model as npm packages or IDE extensions.
- The console intentionally does **not** sandbox external plugin server routes or client code. Third-party plugins may register full backend routes under their `/plugins/<id>/` namespace and execute in the host Node process.
- Operators must not install plugins they do not trust. The platform assumes the principal who can write to `~/.fleet/plugins` already has local code-execution capability.

### Safety Guards

These guards are robustness measures on top of the trust model, not a replacement for it:

- `apiVersion` compatibility gate applies only to external plugins; built-in plugins are exempt.
- Duplicate plugin ids are resolved built-in-first; external duplicates are skipped with a warning.
- **External plugin boot failures are quarantined**: a failing external plugin is skipped and logs a warning, but the console continues to boot. Built-in plugin boot failures remain hard failures.
- Client bundling enforces **plugin-root containment** with symlink awareness: transitive imports that escape the plugin root are rejected at bundle time.
- Manifest, shim, and bundled client payloads must not leak tokens, terminal tickets, raw filesystem paths, provider session ids, transcript paths, or sensitive fields. Bundle path comments are normalized relative to the plugin root so absolute home paths do not appear in browser payloads.
- Three-layer error boundaries isolate plugin failures: loader-level, settings-section level, and operation-panel level (`PluginErrorBoundary` from `@fleet-console/sdk/react/browser`).

### Sample

- `examples/plugins/notes/` demonstrates a minimal external plugin with a custom Operation panel, a Settings section, and a backend route. To exercise the discovery path, copy the directory to `~/.fleet/plugins/notes` in an isolated HOME.

## Host↔Plugin Reactive Channel

- The host bridges plugin capabilities to console client state through `createHostCapabilities` (`core/client/src/plugin-capabilities.ts`). It overwrites the SDK no-op defaults for `notifications` and `status` with store-bound implementations:
  - `notifications.emit` feeds `operationNotifications` (ALERTS are shown only for Operations that are not currently visible).
  - `status.set` / `status.clear` feed `operationStatus`, which drives the running-panel perimeter progress rim and beacon.
- `theme` is passed to plugins through `OperationRenderContext` (not through a capability), so plugins receive the current `ConsoleTheme` reactively on every canvas render. Host token boundaries remain unchanged: these are transient client-only values; no tokens, paths, or credentials cross into plugin code.
- Terminal renderer and font preferences are **not** in `OperationRenderContext`. The Terminal plugin owns these prefs end-to-end through a module-scoped `useSyncExternalStore` store (`client/shared/terminal-prefs-store.ts`), stored under `fleet-plugin.terminal.renderer` and `fleet-plugin.terminal.font` localStorage keys. All mounted terminal panels subscribe directly and react instantly to settings changes. `fleet-plugin.terminal.*` keys are Terminal plugin-owned; core and other plugins must not read or write them.
- The SDK contract is invariant. Host code may only extend capability implementations; it must not add new capability surface areas or require plugins to import core modules.

## Window System

Operation chrome (maximize, minimize, focus, and the Operations Left SideBar) is host-owned. Plugins render only their panel body through `OperationRenderContext` and do not participate in window-state decisions.

- **Per-panel maximize** (`maximizedOperationId` in `core/client/src/canvas/canvas-store.ts`) is orthogonal to **map fullscreen** (`mapFullscreen`, renamed from the earlier map-level maximize while keeping the same storage key). A maximized panel renders in a temporary full-canvas geometry — the map canvas column (col2), which excludes the SideBar (col1) and the Activity Rail (col3) — over the same instance without remounting. Drag, resize, and geometry persistence are blocked while maximized.
- **Minimize preserves PTY**: minimized panels stay in the DOM with `visibility:hidden` and `inert` instead of unmounting, preserving terminal PTY / WebSocket state. Because the host chrome handles this, all plugins benefit uniformly and plugins need not be PTY-aware.
- **Operations Left SideBar = all-panel chip list**: the left progressive 3-tier SideBar (`rail` 56px / `list` 180px / `detail` 280px) shows every Operation in the current Theater as a vertical chip, sorted by `operationOrder` (drag reorder / Alt+Shift+↑↓). Chips show active highlight (brass), minimized dim, close button (two-step ARM), accent (`--chip-accent` border + 1px ring), and notification count. **Chip leading slot**: a 24×24 non-interactive `<span aria-hidden>` hosts the Operation's kind icon (resolved via `renderKindIcon` — no new SDK surface); if no icon resolves, a neutral fallback glyph is shown. Underway/status state is reflected through CSS class modifiers on the chip (`side-bar-chip--underway-{live|turn|awaiting}`, `side-bar-chip--underway-ring`). Right-clicking a chip opens the accent popover (`onContextMenu` on `<li>`). Accent tints the chip's focus-border channel only — never the icon fill. In `rail` tier, chips are horizontally centred (justify-content:center, padding 0) and labels are hidden. The SideBar header hosts **＋New** (opens a `createPortal` global overlay with `mode="launch"` — Operations catalog only — positioned to the right of the button at `rect.right+8, rect.top`; no transient sidebar width expansion) and a **⚙ Settings** button (active, rail tier hidden) that opens a `createPortal` global overlay with `mode="controls"` — Map fullscreen, Radar sweep, Panel pulse, and Shortcuts (collapsed in `<details>`) — positioned to the right of the button. There is no footer on the SideBar; Map/Radar/PanelPulse controls live exclusively in the ⚙ controls overlay. Width persists per browser at `fleet-console.operations.side-width`; collapsed state at `fleet-console.operations.side-collapsed`. Clicking a chip focuses the Operation (restoring it if minimized); if a panel is currently maximized and the clicked chip is a different Operation, the maximized panel is switched to the clicked Operation (`setMaximizedOperationId`) without triggering a canvas pan.
- **Active Operation SSoT**: `activeOperationId` (`core/client/src/store.ts`) is the single source of truth for active highlight and for `Alt + Left / Right` cycling. The cycle order is the same as the Left SideBar's visible order — the shared `sortOperationsByOrder` helper (`store.ts`) ranks by the canvas `operationOrder` (drag reorder) and falls back to createdAt for unranked Operations — so `Alt + Left / Right` never diverges from the chip list. If the active Operation is minimized, active is cleared. When a new panel is added while maximized, the maximized state is kept and the new panel becomes the maximized one.
- **`operationsHydrated`**: the canvas prunes stale Operation geometries only after the first `operations` fetch has set `operationsHydrated` to `true` (`core/client/src/store.ts`). Until then, pruning is deferred so restored geometry is not discarded during initial load.

## Layout

- `core/host/` — Node-side backend and CLI lifecycle: the HTTP server (`server.ts`), security headers, static serving (`static-console.ts`), observer routes (including Theater registry and cascading Operation/capture removal), generic plugin route and upgrade registration, Theater folder routes (`theater-folder-browser.ts`, `theater-folder-grants.ts`), the SSE helper, `codex/` (Fleet Wiki/Codex API gateway and workspace registration), `theaters.ts` (console-level in-memory TheaterRegistry backed by durable state), `theater.ts` (Theater id hash, realpath canonicalization, and label helpers), the lifecycle modules (`lock.ts`, `paths.ts`, `health.ts`, `stale.ts`), the self-update orchestrator (`update-apply.ts`), and the CLI (`cli.ts`, `cli-bin.ts`, `browser.ts`, `help-style.ts`). Terminal PTY tickets, WebSocket upgrade, session lifecycle, shell launch, and agent launch live in the Terminal plugin under `../fleet-plugins/terminal/server/`. Built by tsup to `dist/cli.mjs` and `dist/cli-bin.mjs`. `help-style.ts` is a CLI-help-only **self-hosted** style helper shared by the console and Codex compatibility CLIs; it must not import from `fleet-cli`, `packages/*`, or `core/client/`, and changes to the shared banner/SGR vocabulary require manual sync across those copies.
- `core/client/` — the Vite React SPA (`core/client/src/`, `core/client/index.html`, `core/client/vite.config.ts`). Must not import Node-only modules or the console backend (`core/host/`).
- `../fleet-plugins/terminal/` — the built-in Terminal plugin package. It provides the Shell and Agent browser panels, plugin route handlers, launch metadata, and absorbed shared/server-shared/client-shared helpers for the single `terminal` plugin.
- `../fleet-plugins/diff/` — the built-in Diff plugin package. It owns git diff backend routes (`/plugins/diff/changed`, `/plugins/diff/file`), `isSafeGitRef` validation, and the Diff rail panel client. Server code (`server/`) and client code (`client/`) are self-contained; no git or file helpers live in `core/host/`.
- `../fleet-plugins/file-explorer/` — the built-in File Explorer plugin package. It owns file listing (`/plugins/file-explorer/files/list`), file reading (`/plugins/file-explorer/files/read`), image serving (`/plugins/file-explorer/files/image`), symlink-aware containment, and the File Explorer rail panel client. Server code (`server/`) and client code (`client/`) are self-contained.
- `tests/` — vitest suites for the reducer, SSE parser, store, terminal, and CLI lifecycle.

## Tech Stack (deliberate)

- **React 19 + Vite + TypeScript.** Chosen because the console's core requirement is smooth incremental streaming UI and the package is slated to grow into the unified Fleet GUI. Do not replace with hand-rolled DOM rendering. `react-router-dom` (`BrowserRouter` with `basename="/console"`) is the sanctioned client router. Routes: `/` redirects to `/operations`; `/operations` renders the carrier observation surface (the Map canvas of session panels + JobView); unknown paths redirect to `/operations`. The console backend already serves extensionless `/console/*` paths as `index.html` (SPA fallback in `static-console.ts`), so client-side routes require **no** backend change. Routing state belongs to react-router; observation data stays in the external `store.ts`. Do not add a state-management library until that store proves insufficient.
- State lives in a framework-agnostic external store (`core/client/src/store.ts`) bridged via `useSyncExternalStore`. Pure reduction logic stays in `core/client/src/reduce.ts` and must remain React-free and unit-tested.
- Web fonts are self-hosted via `@fontsource-variable/*`. External font CDNs are forbidden.
- Browser launch must use OS-level commands via `child_process.spawn`; do not add an `open` dependency.

## Streaming Invariants

- `track:text` / `track:thought` events are **deltas**; the reducer appends them per track. Never treat them as snapshots.
- Event ids (the console-assigned `observedId`) are globally monotonic across all registered CLI sessions; the reducer must ignore non-advancing ids so snapshot resync and live frames can overlap safely.
- Snapshot rebuild (`/observer/jobs`) and live SSE application must go through the same reducer (`applyEvent`) — no second interpretation of event payloads.
- The output view keeps pin-to-bottom follow behavior: pinned within slack distance, released on upward scroll, restored via the follow button. Removing this is a UX regression.
- `sentTextLength` tracks emitted length from `textLength` metadata so retention clamping on the console-backend side stays visible to the operator.

## Right Rail (Activity Rail)

The right rail (`core/client/src/rail/`) is a persistent 48px vertical icon column at the right edge of the Operations canvas. Selecting an icon opens an inboard panel (312px) beside the icons; re-clicking the active icon collapses the panel while keeping the rail visible.

**Right-edge handle separation** — two handles share the right edge and must not overlap:

| Handle | z-index token | Element | Notes |
|--------|--------------|---------|-------|
| Activity Rail | `--z-rail: 10` | `.right-rail` | Lowest; canvas-grid column 2 |
| Codex Side | `--z-codex-side: 20` | `.codex-side-panel` | Overlay above canvas |

These CSS variables are declared in `rail.css` and must not be inlined elsewhere. ALERTS and Codex are both built-in rail panels; the former floating right-edge ALERTS dock and its `--z-alerts-dropdown` token were removed.

**RailPanel registration**:

- `RailPanelDescriptor` is the sole SDK surface for rail panels, defined in `@fleet-console/sdk/rail`.
- **Core built-in panels** (`rail/built-in-panels.ts` → `BUILT_IN_RAIL_PANELS = [alertsPanel, codexPanel]`) are core-owned, do **not** pass through the plugin registry, and render **above** the plugin panels in the icon column, separated by a `.right-rail-divider`. ALERTS (`id: "alerts"`) is the first built-in panel; Codex (`id: "codex"`) is the second. A built-in panel may ignore the `RailPanelContext` host capabilities and read console state directly (ALERTS does this; Codex uses `ctx.theaterId`).
- Plugins — both statically-resolved built-in plugins (File Explorer, Diff) and external plugins — register rail panels via `FleetClientPlugin.railPanels[]`, which flow through `rail-registry.ts` → `useRailPanels()` and render **after** the divider. `right-rail.tsx` resolves the active panel against the combined `[...builtInPanels, ...pluginPanels]` set.
- Rail panel id deduplication is enforced in `plugin-registry.ts#createPluginRegistry`; the first plugin wins and subsequent duplicates are warned and skipped.
- `apiVersion` compatibility gate applies to external plugins only (enforced in `plugin-registry.ts#loadExternalPlugin`).
- `RailPanelDescriptor.preferredExtraWidth?: number` — when set, the host adds this many px to the active panel slot width; the host reads only the declared value and remains panel-id-agnostic (same mechanism as `useCodexSplitExtraWidth`, additive).

**Layout contract**:

- `.console-body.is-canvas` is `display:grid; grid-template-columns: auto minmax(0,1fr) auto` with `column-gap: var(--space-3)`. Col1 = `<OperationsSideBar>` (width driven by `--side-bar-width` CSS variable); col2 = the Operations map canvas; col3 = `<RightRail>` (floating glass card).
- The SideBar (col1), the Operations map (col2), and the Activity Rail (col3) are **independent**: per-panel maximize (`maximizedOperationId !== null`) is confined to the map canvas (col2) and does **not** collapse the SideBar or Rail columns. The maximized panel fills col2 (which already excludes the SideBar and Rail), so both stay visible and reflow the canvas if opened/closed while a panel is maximized. `.console-body.is-canvas` no longer takes an `is-map-fullscreen` modifier; that modifier remains only on `.console-shell` for map fullscreen (topbar collapse).
- The `canvas.tsx` `ResizeObserver` naturally reflows the canvas width when the rail opens/closes — no manual layout math is needed.
- `.console-shell` grid (64px header + 1fr body) is immutable; only `.console-body.is-canvas` grid changes.

**Design rules for RailPanel chrome**:

- Active icon = `--brass`; idle = `--ink-fog`; hover = `--ink-spectral`. Do **not** use `--aurora` for rail icon states.
- Active icon carries a left-edge 2px `--brass` bar (`.right-rail-ico.is-active::before`).
- Panel open/close transition = `width var(--duration-base) var(--ease-spring)`. `prefers-reduced-motion: reduce` must short-circuit to `0.01ms`.
- Panel chrome (header 46px min-height + body 1fr) follows the mock `.panel` pattern. Panel body content is plugin-owned; chrome is host-owned.
- Viewer-surface syntax/diff colors go in new surface CSS files (e.g., `rail-viewer.css`); `theme.css` is immutable.

## Design Identity — "Maritime Console"

The console is the operations variant of Fleet Wiki's **Maritime Codex** language: same deep-water ink, brass instrumentation, aurora life signals, glass surfaces, and codex motion grammar, but tuned for live observation rather than reading. It is a command instrument over the same sea, not an editorial document view.

- **Relationship to Maritime Codex**: `core/client/src/codex/**` owns the migrated Maritime Codex reading surface. Console may translate the vocabulary for operations needs, but it must stay visibly related through the shared token system, glass atmosphere, brass/aurora pairing, Fraunces display type, and `codex-rise` motion.
- **Color semantics**:
  - `brass` means "지금 보고 있는 곳" — selected job brass dot indicator, active navigation, structural decoration, and non-live active/focus-adjacent emphasis.
  - `aurora` means "지금 살아있는 것" — streaming status, live dots, tenant beacons, stream caret, follow button, and `connection-chip--live`. Unlike Fleet Wiki, console does not reserve aurora only for document linkage because there is no document-link concept here.
  - `coral` means error/bad; `--warn` (amber, near `oklch(80% 0.13 85)`) means warning/connecting; neutral ink means idle.
  - User accents are a user-chosen hue (any hue across the wheel — red/amber/green included) that **occupies the same outer-edge channel the focus highlight uses** — the border outline plus its 1px ring — on **both the SideBar chip and its canvas Operation panel**, fed by `--chip-accent` / `--op-accent`. When an accent is set it **takes over that focus channel in the accent color and shows permanently, regardless of focus**: an accented panel/chip always wears the accent on its border (and focus ring), so it reads as "focused in the user's hue" whether or not it is the active Operation, and focusing it keeps the accent instead of reverting to brass. Focus brass is used only when no accent is set (active → brass border/ring; idle → neutral rim). Status keeps its own separate channel — the underway/in-progress aurora/warn conic rides the edge `::before` (a minimized chip's `::before` carries the rotating conic; a visible operation's rotation is owned by its canvas panel) and the running glow/wake is unchanged — so an accented Operation shows its accent border together with the running conic. The SideBar chip's active brass *fill* stays as a secondary focus highlight beneath the accent outline. The accent never animates on its own (an infinitely orbiting ring is reserved for the functional in-progress signal) and never tints the panel/chip fill, name, beacon, count, close, or the status conic.
- **Typography**: `Fraunces Variable` is display type for the topbar brand, job titles, idle marks, and large headings. `Manrope Variable` is the default UI family. `JetBrains Mono Variable` is for stream output, job ids, timelines, and eyebrow labels with uppercase tracked styling. **Exception**: the Operations terminal (xterm) uses `Cascadia Code` — a terminal-tuned face for box-drawing/Powerline glyph alignment — rendered via the xterm WebGL addon with DOM fallback. This is the sole surface where the console mono identity deliberately diverges from JetBrains Mono; the terminal font lives in the `terminal.tsx` xterm options (xterm takes a JS font string, not a CSS token), so it is not a `theme.css` variable.
- **Surface and atmosphere**: `body::before` owns the multi-radial cold teal + brass afterglow field, and `body::after` owns the `feTurbulence` grain overlay. Sidebar, selected-job stage, timeline dock, and job summary are glass cards using `backdrop-filter: blur(18px) saturate(140%)`, `--surface-glass`, `--surface-rim`, `--shadow-soft`, and `--radius-xl`/large-radius surfaces.
- **Motion**: panes use one first-paint `codex-rise` reveal (720ms, `--ease-spring`, topbar/sidebar/stage staggered 40/120/200ms). Live dots use aurora pulse, the stream caret keeps its blink, and ambient infinite motion is forbidden. `prefers-reduced-motion` must continue to short-circuit animation. Exception: the Operations canvas background may render a user-toggleable ambient radar sweep, paired with a user-toggleable panel-pulse perimeter animation, that persists per browser; both default on in the stable channel but default off in the local (unpublished `pnpm`) channel so dev restarts start quiet, an explicit per-browser toggle preference always wins over the channel default, and both remain short-circuited by `prefers-reduced-motion`. Second exception: a running Operation panel renders a continuous perimeter "wake" ripple as a functional status signal (not ambient decoration) — it is driven by the plugin `ClientOperationStatusCapability` value reported through `operationStatus` (`running` = amber `--warn` turn, `live` = aurora), appears only while work is in progress, and stays short-circuited by `prefers-reduced-motion`, degrading to a static tinted rim and glow. Like the live-dot pulse, this is allowed functional status motion, not forbidden ambient motion. Third exception: the Operations canvas draws a continuous "command tether" between a parent Operation and each child — a base aurora link with a marching aurora "signal current" (dashed flow) that always animates from parent toward child to make the Operation tree (`parentId` lineage) legible. It is a functional structural status signal (not ambient decoration), uses aurora only (no brass-role mixing), is rendered beneath the glass panels, follows the panels as they move, stays short-circuited by `prefers-reduced-motion` (degrading to a static dashed tether), and pauses while the tab is hidden.
- **Hard bans**: no font CDN; no `Inter`/`Roboto`/`Arial`/`system-ui` as the first font family; no solid `#fff` or `#000` backgrounds; no card/button/chip radius at or below 4px; no removal of `prefers-reduced-motion`; no mixing brass and aurora roles; no reintroduction of `--carbon-*` or `--signal-*` token families; the user accent lives only in the focus outline channel it shares with brass (border + focus ring) — when set it overrides the focus brass there and shows permanently; no accent leak into the panel/chip fill, name, beacon, count, close, or the status (underway conic / aurora-warn / running glow) channel.
- CSS stays in three layers: `theme.css` (tokens/reset/keyframes only), `layout.css` (shell grid/breakpoints only), `components.css` (every concrete surface).

## TypeScript File Structure

All `.ts`/`.tsx` files follow:

```text
imports -> types/interfaces -> constants -> functions/components
```

## Build & Serve Contract

- `pnpm --filter @dotobokuri/fleet-console build` runs tsup (`core/host/cli.ts` → `dist/cli.mjs`, `core/host/cli-bin.ts` → `dist/cli-bin.mjs`, `../fleet-plugins/terminal/routes.ts` → `dist/fleet-plugins/terminal/routes.mjs`, `../fleet-plugins/diff/routes.ts` → `dist/fleet-plugins/diff/routes.mjs`, `../fleet-plugins/file-explorer/routes.ts` → `dist/fleet-plugins/file-explorer/routes.mjs`) and Vite (`core/client/` → `dist/client/` with `base: "/console/"`). There is **no** embed step: the console backend serves its own `dist/client/` directly under `/console/` (loopback-only). Changing `base` or the output layout breaks the static-serving contract.
- This package **is** the HTTP server. The backend owns its own loopback server, lifecycle, and `/console/` serving; the CLI starts and stops that server rather than launching a separate daemon.
- **npm publish contract**: tsup bundles every `@dotobokuri/*` workspace dependency and `@fleet-console/sdk` inline (`noExternal: [/^@dotobokuri\//, /^@fleet-console\/sdk(\/|$)/]`) so the published package is self-contained; only `node-pty` (native binding) and `ws` (dynamic `require`) stay external. `scripts/publish-fleet-console.mjs` drops `private`, replaces `dependencies` with just those two externals, and injects the `node-pty` `postinstall`. Do **not** add a statically-imported workspace package without confirming it bundles, and re-verify the published manifest with `npm pack` after touching `noExternal` or runtime deps — leaving a `workspace:*` dependency in the manifest breaks `npm install`.
- **Plugin native/external module resolution**: a built-in plugin's server code that `require()`s a native or `external` module (`node-pty`, `ws`) must resolve it against the `@dotobokuri/fleet-console` package, not via a bare `createRequire(import.meta.url)`. Plugins load from an esbuild **cache bundle** (`node_modules/.cache/fleet-console-plugin-*`), so a `createRequire` rooted there can resolve a **stale copy from a parent-workspace `node_modules`** and fail at runtime with `posix_spawnp failed` — typecheck and build stay green, so only a runtime/e2e run catches it. The Terminal plugin's `server/shared/pty.ts` (`findConsolePackageRequire`) is the reference, guarded by a `launch.test.ts` regression test.

## Tests

- `pnpm --filter @dotobokuri/fleet-console test`
- `pnpm --filter @dotobokuri/fleet-console typecheck`
- `pnpm --filter @dotobokuri/fleet-console build`
