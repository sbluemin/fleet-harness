# Fleet Console Doctrine

`runtime/fleet-console` owns the Fleet Console — a standalone fullstack product: its own loopback HTTP backend plus the React web surface for observing carrier jobs, live output streams from console-owned terminal sessions, and the Codex/Fleet Wiki web surface, driven by the `fleet-console` CLI lifecycle. It is the unified Fleet GUI runtime.

## Owns

- The console HTTP backend (loopback-only): its own server skeleton, security headers, static `/console/` serving of its own `dist/client/`, the browser observer REST/SSE surface, and the terminal PTY WebSocket. The console no longer imports or launches the retired gateway package.
- The server lifecycle: lock file, runtime paths, health probe, and build-stale detection are console-owned. `fleet-console` is the daemon, not a launcher over someone else's daemon.
- The `fleet-console` CLI entry point (`./cli` export, `dist/cli.mjs`): `start` (the default when no subcommand is given) ensures the local console server and opens the console URL in a browser; if a healthy daemon already exists, it opens that daemon's URL without starting a new server or erroring. `stop` stops the console server; `restart` stops the console server then starts a fresh one and opens it; `status` prints server health, endpoint, console URL, and registered-workspace count. The server binds to an OS-assigned random loopback port and records the actual port in the lock file, so consumers discover the port from the lock endpoint. `--help`/`-h` prints the banner-style help. `fleet console <args>` in `fleet-cli` relays the full argument list to this CLI as a child process, so every subcommand works through both `fleet console …` and the standalone `fleet-console …` binary. The root `pnpm fleet-console` script runs it from source via `tsx`; unpublished local runs isolate runtime files under the project workspace `.fleet/console` unless `FLEET_CONSOLE_DIR` is set, while published stable builds continue using the OS temp directory.
- Console-owned terminal sessions are spawned server-side and observed in-process; carrier events flow directly into the observer store and browser SSE without a separate fleet-cli registration channel.
- Console durable state is persisted in `~/.fleet/console/state.json` (`createDurableJsonStore`, `sensitivity: "sensitive"`). The console server is the sole writer; the file stores `{ version: 1, theaters, operations }`. On startup the server restores Theaters and Operations into a dormant state (no PTY), and Operation state survives console restarts.
- A capture inbound channel writes `~/.fleet/console/captures/{fleetSessionId}.json`. Provider CLI SessionStart hooks record provider session ids via `fleet-console hook capture-session <provider>`; the server reads the capture file, merges the provider session id into durable state, and cleans up the capture file. This is separate from the console lock file in `os.tmpdir()`.
- The React SPA served from the console backend at `/console/`: layout, components, styles, and visual identity. The global navigation bar owns **Theater** selection — a project root directory that groups console-owned terminal sessions and Codex wiki context. The Operations sidebar (under the Operation nav tab) lists terminal sessions filtered to the active Theater and provides a launch control that asks the operator to choose an Agent CLI before starting a new terminal session; each session lists its carrier job history (active and finished) in registration order, and selecting a job opens a centered streaming overlay over that session's terminal, scoped to the active session's jobs. A console-wide Operation quick-search (Cmd/Ctrl+K) searches terminal sessions across all Theaters, switches to the selected Operation's Theater, selects that Operation, and navigates to `/operations`; on `/codex` paths the same shortcut yields to Codex's own search.
- The Codex/Fleet Wiki web surface under `/console/codex`: the console-owned Codex server gateway, workspace registry, wiki API routes, migrated vanilla TypeScript Maritime Codex client, `fleet wiki` compatibility helpers, and standalone `fleet-wiki` binary shim. The console-level **TheaterRegistry** is the source of truth for project roots and does not require a Fleet Wiki knowledge root; the Codex `WorkspaceRegistry` is the subset of Theaters whose directories contain a Fleet Wiki knowledge root. Codex must remain mounted under the Fleet Console GNB without an iframe or proxy daemon.
- The observer-side client contract: REST snapshot fetches and the SSE consumption loop with reconnect/resync.
- The streaming view model: the event reducer that folds `CarrierJobStreamEvent` timelines into per-job, per-track views with incremental text accumulation.

## Codex / Fleet Wiki Surface

- Canonical Codex workspace routes live under `/console/codex/w/:ws/...`; MRU-compatible API routes live under `/console/codex/api/...`. Do not reintroduce global `/api/...` wiki routes because console owns its own local API namespace.
- The console-level **Theater** is the parent concept for project roots. Codex workspaces share the same id space (`workspaceHash(realpath(dir))`) but are a strict subset of the Theater registry (`hasWiki=true`). The Codex left workspace switcher is removed; Theater selection in the global navigation bar is the only workspace switch, and Theaters without a Fleet Wiki knowledge root render a "Codex 없음" state instead of mounting a wiki surface.
- The migrated Codex client stays Vanilla TypeScript under `client/src/codex/**`; do not rewrite it into React state or components beyond the React mount host.
- Preserve Maritime Codex UX: reading flow, raw viewer, Drydock queue, conflicts, index/log views, command palette, Manifest/ToC rails, copy-context actions, diagram lightbox, brass/aurora roles, and self-hosted fonts.
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
- Folder browser routes (`POST /terminal/folders/list`, `POST /terminal/folders/grants`) are gated by `validateHost` then `isTerminalAuthorized` (the same Origin boundary as all terminal routes). No adminToken or bearer auth is added. Folder selection is browser UI plus loopback fs APIs; no OS-native dialog or child process is spawned. Selected absolute paths appear only in list and grant responses; they are not included in session, Theater, observer, or SSE payloads. When a Theater is registered the resolved cwd is stored in durable local state (`sensitivity: "sensitive"`) as before — it is not transmitted to the browser.

## Carrier Readiness/Settings Boundary

- `runtime/fleet-console/src/**` may import `@dotobokuri/fleet-carriers` public root exports to consume Carrier Readiness read models and mutate global Carrier Settings through the carrier store.
- `runtime/fleet-console/client/**` must not import `@dotobokuri/fleet-carriers`, carrier persona modules, deep carrier paths, or Node-only carrier runtime modules.
- Fleet Console may render and edit display-safe carrier settings data such as carrier id, display name, role/category, resolved CLI/model/effort, Task Force backend count/configuration, and subagent mode/tag.
- `fleet-carriers` remains the source of truth for carrier persona defaults, carrier-store interpretation, store mutation, and carrier read-model construction. Console must not copy or reconstruct carrier persona policy or carrier runtime state.
- Console must not deep-import `@dotobokuri/fleet-carriers/src/**`, `packages/fleet-carriers/src/**`, `runtime/fleet-cli/**`, or `@dotobokuri/fleet-cli`.
- Carrier readiness/settings browser payloads must not serialize prompt bodies, raw persona instructions, executor tool allowlists, tokens, credential values, auth env details, terminal/session/admin tickets, or raw filesystem paths.

## Server-side Dependency Boundary

- `runtime/fleet-console/src/**` may import `@dotobokuri/fleet-admiral` public root exports for server-only Agent CLI launch/runtime assembly. `runtime/fleet-console/client/**` must not import `@dotobokuri/fleet-admiral`.

## Layout

- `src/` — Node-side backend and CLI lifecycle: the HTTP server (`server.ts`), security headers, static serving (`static-console.ts`), observer routes (including `/observer/theaters*` Theater registry, session launch, and `DELETE /observer/theaters/:theaterId` for Theater plus cascading Operation/capture removal), the SSE helper, `codex/` (Fleet Wiki/Codex API gateway and workspace registration), `theaters.ts` (console-level in-memory TheaterRegistry backed by durable state), `theater.ts` (Theater id hash, realpath canonicalization, and label helpers), `terminal/` (PTY ticket/session/ws transport, `POST /terminal/sessions/:sessionId/resume` for lazy on-open resume of dormant Operations, and `DELETE /terminal/sessions/:sessionId` which kills a live session and removes it or simply removes a dormant session, persisting the change in all cases; console terminal sessions resolve Agent CLI launch specs through `@dotobokuri/fleet-admiral`, spawn the selected provider CLI directly, inject carrier job completion system-reminders (and, on Operation rename, a `/rename <name>` slash command) only into the originating session's PTY, and bridge carrier runtime events into console-owned observability without exposing MCP/session tokens, terminal tickets, or system reminders to the browser; closing the browser view or switching Operations does not terminate the PTY — live sessions persist until the child process exits, an operator explicitly terminates the session, or the server stops; restarting the console restores Operations in a dormant state without a PTY and resumes them lazily when opened), the lifecycle modules (`lock.ts`, `paths.ts`, `health.ts`, `stale.ts`), and the CLI (`cli.ts`, `cli-bin.ts`, `browser.ts`, `help-style.ts`). Built by tsup to `dist/cli.mjs` and `dist/cli-bin.mjs`. `help-style.ts` is a CLI-help-only **self-hosted** style helper shared by the console and Codex compatibility CLIs; it must not import from `fleet-cli`, `packages/*`, or `client/`, and changes to the shared banner/SGR vocabulary require manual sync across those copies.
- `client/` — the Vite React SPA (`client/src/`, `client/index.html`, `client/vite.config.ts`). Must not import Node-only modules or the console backend (`src/`).
- `tests/` — vitest suites for the reducer, SSE parser, store, terminal, and CLI lifecycle.

## Tech Stack (deliberate)

- **React 19 + Vite + TypeScript.** Chosen because the console's core requirement is smooth incremental streaming UI and the package is slated to grow into the unified Fleet GUI. Do not replace with hand-rolled DOM rendering. A second surface has now landed (the Welcome dashboard), so `react-router-dom` (`BrowserRouter` with `basename="/console"`) is the sanctioned client router. Routes: `/` renders **Welcome** (the live dashboard); `/operations` renders the carrier observation surface (Sidebar + JobView); unknown paths redirect to `/`. The console backend already serves extensionless `/console/*` paths as `index.html` (SPA fallback in `static-console.ts`), so client-side routes require **no** backend change. Routing state belongs to react-router; observation data stays in the external `store.ts`. Do not add a state-management library until that store proves insufficient.
- State lives in a framework-agnostic external store (`client/src/store.ts`) bridged via `useSyncExternalStore`. Pure reduction logic stays in `client/src/reduce.ts` and must remain React-free and unit-tested.
- Web fonts are self-hosted via `@fontsource-variable/*`. External font CDNs are forbidden.
- Browser launch must use OS-level commands via `child_process.spawn`; do not add an `open` dependency.

## Streaming Invariants

- `track:text` / `track:thought` events are **deltas**; the reducer appends them per track. Never treat them as snapshots.
- Event ids (the console-assigned `observedId`) are globally monotonic across all registered CLI sessions; the reducer must ignore non-advancing ids so snapshot resync and live frames can overlap safely.
- Snapshot rebuild (`/observer/jobs`) and live SSE application must go through the same reducer (`applyEvent`) — no second interpretation of event payloads.
- The output view keeps pin-to-bottom follow behavior: pinned within slack distance, released on upward scroll, restored via the follow button. Removing this is a UX regression.
- `sentTextLength` tracks emitted length from `textLength` metadata so retention clamping on the console-backend side stays visible to the operator.

## Design Identity — "Maritime Console"

The console is the operations variant of Fleet Wiki's **Maritime Codex** language: same deep-water ink, brass instrumentation, aurora life signals, glass surfaces, and codex motion grammar, but tuned for live observation rather than reading. It is a command instrument over the same sea, not an editorial document view.

- **Relationship to Maritime Codex**: `client/src/codex/**` owns the migrated Maritime Codex reading surface. Console may translate the vocabulary for operations needs, but it must stay visibly related through the shared token system, glass atmosphere, brass/aurora pairing, Fraunces display type, and `codex-rise` motion.
- **Color semantics**:
  - `brass` means "지금 보고 있는 곳" — selected job brass dot indicator, active navigation, structural decoration, and non-live active/focus-adjacent emphasis.
  - `aurora` means "지금 살아있는 것" — streaming status, live dots, tenant beacons, stream caret, follow button, and `connection-chip--live`. Unlike Fleet Wiki, console does not reserve aurora only for document linkage because there is no document-link concept here.
  - `coral` means error/bad; `--warn` (amber, near `oklch(80% 0.13 85)`) means warning/connecting; neutral ink means idle.
- **Typography**: `Fraunces Variable` is display type for the topbar brand, job titles, idle marks, and large headings. `Manrope Variable` is the default UI family. `JetBrains Mono Variable` is for stream output, job ids, timelines, and eyebrow labels with uppercase tracked styling. **Exception**: the Operations terminal (xterm) uses `Cascadia Code` — a terminal-tuned face for box-drawing/Powerline glyph alignment — rendered via the xterm WebGL addon with DOM fallback. This is the sole surface where the console mono identity deliberately diverges from JetBrains Mono; the terminal font lives in the `terminal.tsx` xterm options (xterm takes a JS font string, not a CSS token), so it is not a `theme.css` variable.
- **Surface and atmosphere**: `body::before` owns the multi-radial cold teal + brass afterglow field, and `body::after` owns the `feTurbulence` grain overlay. Sidebar, selected-job stage, timeline dock, and job summary are glass cards using `backdrop-filter: blur(18px) saturate(140%)`, `--surface-glass`, `--surface-rim`, `--shadow-soft`, and `--radius-xl`/large-radius surfaces.
- **Motion**: panes use one first-paint `codex-rise` reveal (720ms, `--ease-spring`, topbar/sidebar/stage staggered 40/120/200ms). Live dots use aurora pulse, the stream caret keeps its blink, and ambient infinite motion is forbidden. `prefers-reduced-motion` must continue to short-circuit animation. Exception: the Operations canvas background may render a user-toggleable ambient radar sweep that defaults on and persists per browser; it remains short-circuited by `prefers-reduced-motion`.
- **Hard bans**: no font CDN; no `Inter`/`Roboto`/`Arial`/`system-ui` as the first font family; no solid `#fff` or `#000` backgrounds; no card/button/chip radius at or below 4px; no removal of `prefers-reduced-motion`; no mixing brass and aurora roles; no reintroduction of `--carbon-*` or `--signal-*` token families.
- CSS stays in three layers: `theme.css` (tokens/reset/keyframes only), `layout.css` (shell grid/breakpoints only), `components.css` (every concrete surface).

## TypeScript File Structure

All `.ts`/`.tsx` files follow:

```text
imports -> types/interfaces -> constants -> functions/components
```

## Build & Serve Contract

- `pnpm --filter @dotobokuri/fleet-console build` runs tsup (`src/cli.ts` → `dist/cli.mjs`) and Vite (`client/` → `dist/client/` with `base: "/console/"`). There is **no** embed step: the console backend serves its own `dist/client/` directly under `/console/` (loopback-only). Changing `base` or the output layout breaks the static-serving contract.
- This package **is** the HTTP server. The backend owns its own loopback server, lifecycle, and `/console/` serving; the CLI starts and stops that server rather than launching a separate daemon.
- **npm publish contract**: tsup bundles every `@dotobokuri/*` workspace dependency inline (`noExternal: [/^@dotobokuri\//]`) so the published package is self-contained; only `node-pty` (native binding) and `ws` (dynamic `require`) stay external. `scripts/publish-fleet-console.mjs` drops `private`, replaces `dependencies` with just those two externals, and injects the `node-pty` `postinstall`. Do **not** add a statically-imported workspace package without confirming it bundles, and re-verify the published manifest with `npm pack` after touching `noExternal` or runtime deps — leaving a `workspace:*` dependency in the manifest breaks `npm install`.

## Tests

- `pnpm --filter @dotobokuri/fleet-console test`
- `pnpm --filter @dotobokuri/fleet-console typecheck`
- `pnpm --filter @dotobokuri/fleet-console build`
