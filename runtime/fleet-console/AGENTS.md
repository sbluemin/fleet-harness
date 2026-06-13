# Fleet Console Doctrine

`runtime/fleet-console` owns the Fleet Console — the web surface for observing Fleet Gateway tenants, carrier jobs, and live output streams, plus the `fleet-console` CLI launcher. It is an independent runtime project (structured like `runtime/fleet-wiki-ui`), the seed of the unified Fleet GUI, and is expected to absorb additional surfaces (e.g., Fleet Wiki) over time.

## Owns

- The `fleet-console` CLI entry point (`./cli` export, `dist/cli.mjs`): a subcommand launcher over the `@dotobokuri/fleet-gateway` public lifecycle API. `start` (the default when no subcommand is given) ensures the local gateway daemon and opens the console URL in a browser; `stop` stops the daemon; `status` prints daemon health, endpoint, console URL, and workspace count. `--help`/`-h` prints the banner-style help. `fleet console <args>` in `fleet-cli` relays the full argument list to this CLI as a child process, so every subcommand works through both `fleet console …` and the standalone `fleet-console …` binary. The root `pnpm fleet-console` script runs it from source via `tsx` after building the gateway.
- The React SPA served at the gateway's `/console/` path: layout, components, styles, and visual identity.
- The observer-side client contract: REST snapshot fetches (`/observer/tenants`, `/observer/jobs`) and the `/observer/events` SSE consumption loop with reconnect/resync.
- The streaming view model: the event reducer that folds `CarrierJobStreamEvent` timelines into per-job, per-track views with incremental text accumulation.
- The observer token handoff shape: launcher passes the token once through the URL fragment (never a query string); the client moves it to `sessionStorage["fleet-console-observer-token"]` and strips the fragment.

## Must Not Own

- Gateway daemon internals — lock files, trust verification, tenant/token issuance, health probing, or any server-side HTTP handling (owned by `runtime/fleet-gateway`; the CLI launcher only consumes the gateway's public lifecycle API).
- Static asset serving (the gateway serves the embedded `dist/client/` from loopback).
- Fleet tool builders, carrier persona policy, or provider-specific launch logic.

## Layout

- `src/` — Node-side CLI launcher (`cli.ts`, `browser.ts`, `help-style.ts`). Built by tsup to `dist/cli.mjs`. May depend on `@dotobokuri/fleet-gateway`; the gateway must stay **external** in the tsup bundle (bundling it would break the gateway's `import.meta.url`-based server module resolution). `help-style.ts` is a CLI-help-only **self-hosted** style helper mirroring `runtime/fleet-wiki-ui/src/help-style.ts` and the `fleet-cli` styles SSoT; it must not import from `fleet-cli`, `packages/*`, or `client/`, and changes to the shared banner/SGR vocabulary require manual sync across those copies.
- `client/` — the Vite React SPA (`client/src/`, `client/index.html`, `client/vite.config.ts`). Must not import Node-only modules or `@dotobokuri/fleet-gateway`.
- `tests/` — vitest suites for the reducer, SSE parser, store, and CLI launcher.

## Tech Stack (deliberate)

- **React 19 + Vite + TypeScript.** Chosen because the console's core requirement is smooth incremental streaming UI and the package is slated to grow into the unified Fleet GUI. Do not replace with hand-rolled DOM rendering. A second surface has now landed (the Welcome dashboard), so `react-router-dom` (`BrowserRouter` with `basename="/console"`) is the sanctioned client router. Routes: `/` renders **Welcome** (the live dashboard, no token gate); `/operations` renders the carrier observation surface (Sidebar + JobView, behind the observer-token gate); unknown paths redirect to `/`. The gateway already serves extensionless `/console/*` paths as `index.html` (SPA fallback in `static-console.ts`), so client-side routes require **no** gateway change. Routing state belongs to react-router; observation data stays in the external `store.ts`. Do not add a state-management library until that store proves insufficient.
- State lives in a framework-agnostic external store (`client/src/store.ts`) bridged via `useSyncExternalStore`. Pure reduction logic stays in `client/src/reduce.ts` and must remain React-free and unit-tested.
- Web fonts are self-hosted via `@fontsource-variable/*`. External font CDNs are forbidden.
- Browser launch must use OS-level commands via `child_process.spawn`; do not add an `open` dependency.

## Streaming Invariants

- `track:text` / `track:thought` events are **deltas**; the reducer appends them per track. Never treat them as snapshots.
- Event ids are monotonic per gateway run; the reducer must ignore non-advancing ids so snapshot resync and live frames can overlap safely.
- Snapshot rebuild (`/observer/jobs`) and live SSE application must go through the same reducer (`applyEvent`) — no second interpretation of event payloads.
- The output view keeps pin-to-bottom follow behavior: pinned within slack distance, released on upward scroll, restored via the follow button. Removing this is a UX regression.
- `sentTextLength` tracks emitted length from `textLength` metadata so retention clamping on the gateway side stays visible to the operator.

## Design Identity — "Maritime Console"

The console is the operations variant of Fleet Wiki's **Maritime Codex** language: same deep-water ink, brass instrumentation, aurora life signals, glass surfaces, and codex motion grammar, but tuned for live observation rather than reading. It is a command instrument over the same sea, not an editorial document view.

- **Relationship to Maritime Codex**: `runtime/fleet-wiki-ui` remains the reference doctrine and visual source material. Console may translate the vocabulary for operations needs, but it must stay visibly related through the shared token system, glass atmosphere, brass/aurora pairing, Fraunces display type, and `codex-rise` motion.
- **Color semantics**:
  - `brass` means "지금 보고 있는 곳" — selected job brass dot indicator, active navigation, structural decoration, and non-live active/focus-adjacent emphasis.
  - `aurora` means "지금 살아있는 것" — streaming status, live dots, tenant beacons, stream caret, follow button, and `connection-chip--live`. Unlike Fleet Wiki, console does not reserve aurora only for document linkage because there is no document-link concept here.
  - `coral` means error/bad; `--warn` (amber, near `oklch(80% 0.13 85)`) means warning/auth-needed/connecting; neutral ink means idle.
- **Typography**: `Fraunces Variable` is display type for the topbar brand, job titles, idle marks, and large headings. `Manrope Variable` is the default UI family. `JetBrains Mono Variable` is for stream output, job ids, timelines, and eyebrow labels with uppercase tracked styling.
- **Surface and atmosphere**: `body::before` owns the multi-radial cold teal + brass afterglow field, and `body::after` owns the `feTurbulence` grain overlay. Sidebar, selected-job stage, timeline dock, and job summary are glass cards using `backdrop-filter: blur(18px) saturate(140%)`, `--surface-glass`, `--surface-rim`, `--shadow-soft`, and `--radius-xl`/large-radius surfaces.
- **Motion**: panes use one first-paint `codex-rise` reveal (720ms, `--ease-spring`, topbar/sidebar/stage staggered 40/120/200ms). Live dots use aurora pulse, the stream caret keeps its blink, and ambient infinite motion is forbidden. `prefers-reduced-motion` must continue to short-circuit animation.
- **Hard bans**: no font CDN; no `Inter`/`Roboto`/`Arial`/`system-ui` as the first font family; no solid `#fff` or `#000` backgrounds; no card/button/chip radius at or below 4px; no removal of `prefers-reduced-motion`; no mixing brass and aurora roles; no reintroduction of `--carbon-*` or `--signal-*` token families.
- CSS stays in three layers: `theme.css` (tokens/reset/keyframes only), `layout.css` (shell grid/breakpoints only), `components.css` (every concrete surface).

## TypeScript File Structure

All `.ts`/`.tsx` files follow:

```text
imports -> types/interfaces -> constants -> functions/components
```

## Build & Serve Contract

- `pnpm --filter @dotobokuri/fleet-console build` runs tsup (`src/cli.ts` → `dist/cli.mjs`), Vite (`client/` → `dist/client/` with `base: "/console/"`), and finally re-runs the gateway's `scripts/embed-console.mjs` to push `dist/client/` into the gateway's `dist/client/`.
- `runtime/fleet-gateway` serves that embedded output loopback-only under `/console/`. The embed script resolves this package by monorepo-relative path — **not** a workspace dependency — because this package's prod dependency on the gateway would otherwise create a workspace cycle and break `pnpm -r build` topological ordering. Changing `base` or the output layout breaks the embed contract.
- This package has no HTTP server entry point and must not grow one while the gateway serves the console. The CLI is a launcher, not a server.

## Tests

- `pnpm --filter @dotobokuri/fleet-console test`
- `pnpm --filter @dotobokuri/fleet-console typecheck`
- `pnpm --filter @dotobokuri/fleet-console build`
