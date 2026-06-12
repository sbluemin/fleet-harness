# Fleet Console Doctrine

`runtime/fleet-console` owns the Fleet Console — the web surface for observing Fleet Gateway tenants, carrier jobs, and live output streams, plus the `fleet-console` CLI launcher. It is an independent runtime project (structured like `runtime/fleet-wiki-ui`), the seed of the unified Fleet GUI, and is expected to absorb additional surfaces (e.g., Fleet Wiki) over time.

## Owns

- The `fleet-console` CLI entry point (`./cli` export, `dist/cli.mjs`): ensures the local gateway daemon through the `@dotobokuri/fleet-gateway` public lifecycle API and opens the console URL in a browser. `fleet console` in `fleet-cli` relays to this CLI as a child process.
- The React SPA served at the gateway's `/console/` path: layout, components, styles, and visual identity.
- The observer-side client contract: REST snapshot fetches (`/observer/tenants`, `/observer/jobs`) and the `/observer/events` SSE consumption loop with reconnect/resync.
- The streaming view model: the event reducer that folds `CarrierJobStreamEvent` timelines into per-job, per-track views with incremental text accumulation.
- The observer token handoff shape: launcher passes the token once through the URL fragment (never a query string); the client moves it to `sessionStorage["fleet-console-observer-token"]` and strips the fragment.

## Must Not Own

- Gateway daemon internals — lock files, trust verification, tenant/token issuance, health probing, or any server-side HTTP handling (owned by `runtime/fleet-gateway`; the CLI launcher only consumes the gateway's public lifecycle API).
- Static asset serving (the gateway serves the embedded `dist/client/` from loopback).
- Fleet tool builders, carrier persona policy, or provider-specific launch logic.

## Layout

- `src/` — Node-side CLI launcher (`cli.ts`, `browser.ts`). Built by tsup to `dist/cli.mjs`. May depend on `@dotobokuri/fleet-gateway`; the gateway must stay **external** in the tsup bundle (bundling it would break the gateway's `import.meta.url`-based server module resolution).
- `client/` — the Vite React SPA (`client/src/`, `client/index.html`, `client/vite.config.ts`). Must not import Node-only modules or `@dotobokuri/fleet-gateway`.
- `tests/` — vitest suites for the reducer, SSE parser, store, and CLI launcher.

## Tech Stack (deliberate)

- **React 19 + Vite + TypeScript.** Chosen because the console's core requirement is smooth incremental streaming UI and the package is slated to grow into the unified Fleet GUI. Do not replace with hand-rolled DOM rendering; do not add a router or state-management library until a second surface actually lands.
- State lives in a framework-agnostic external store (`client/src/store.ts`) bridged via `useSyncExternalStore`. Pure reduction logic stays in `client/src/reduce.ts` and must remain React-free and unit-tested.
- Web fonts are self-hosted via `@fontsource-variable/*`. External font CDNs are forbidden.
- Browser launch must use OS-level commands via `child_process.spawn`; do not add an `open` dependency.

## Streaming Invariants

- `track:text` / `track:thought` events are **deltas**; the reducer appends them per track. Never treat them as snapshots.
- Event ids are monotonic per gateway run; the reducer must ignore non-advancing ids so snapshot resync and live frames can overlap safely.
- Snapshot rebuild (`/observer/jobs`) and live SSE application must go through the same reducer (`applyEvent`) — no second interpretation of event payloads.
- The output view keeps pin-to-bottom follow behavior: pinned within slack distance, released on upward scroll, restored via the follow button. Removing this is a UX regression.
- `sentTextLength` tracks emitted length from `textLength` metadata so retention clamping on the gateway side stays visible to the operator.

## Design Identity — "Precision Operations Console"

The console is a cold, precise, dark operations instrument. It must not imitate the Fleet Wiki "Maritime Codex" identity (no serif display, no brass/aurora palette, no glassmorphism-led editorial surfaces).

- **Type**: `Archivo Variable` for UI/display, `Martian Mono Variable` for data/output. No Inter/Roboto/Arial/system-ui as a primary family; no font CDNs.
- **Color**: deep cold carbon base (`--carbon-*`), restrained cool-grey ink scale (`--ink-*`), and a **single signal accent** (electric lime, `--signal`) reserved for *live activity* — streaming state, live dots, the stream caret, the follow button. Semantic states: `--state-ok` (calm cyan-grey), `--state-bad` (coral), `--state-warn` (amber), `--state-idle` (neutral). Tokens are defined in `client/src/styles/theme.css` with `oklch()`; components must reference tokens, never raw hex.
- **Signal discipline**: the lime signal means "alive right now". Using it for terminal/idle/selection states dilutes the instrument's meaning and is a design regression. Two deliberate exceptions are allowed and fixed: the topbar brand sigil (identity mark) and the `:focus-visible` outline (interaction affordance). Anything else must justify itself as live activity.
- **Atmosphere**: the viewport background (signal afterglow gradient + grain) is owned by `body::before`/`body::after` in `theme.css`; components must not redefine it.
- **Motion**: pulse for live dots, blink for the stream caret, one `console-rise` entrance per pane. `prefers-reduced-motion` short-circuits all animation and must stay intact.
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
