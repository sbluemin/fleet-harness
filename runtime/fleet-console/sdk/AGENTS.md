# Fleet Console Plugin SDK Doctrine

`runtime/fleet-console/sdk` is the plugin-facing contract SSoT for Fleet Console. Core host, core client, and plugins may import it; the SDK must not import core, plugin packages, or `@dotobokuri/*`.

## Boundary

- The package name is `@fleet-console/sdk`.
- The package is private, source-only, and dependency-free except React as a peer.
- SDK modules define contracts and stateless authoring/browser helpers only.
- Server-side operation DTO sanitization stays in Fleet Console core and is intentionally excluded from SDK exports.
- Browser readback validators may live here, but they must only reject unsafe payloads already sanitized by core.

## Plugin Contract

- `OperationRenderContext` carries host-owned chrome state into the plugin render reactively: `theme` (`ConsoleTheme`: `maritime` | `carbon`) and `terminalRenderer` (`TerminalRenderer`: `webgl` | `dom`). Plugins receive these values in the render context and must consume them there; they must not read the core theme directly. Because the context is rebuilt when the canvas re-renders, theme changes are reflected immediately.
- `ClientOperationStatusCapability` lets a plugin report Operation activity: `set(operationId, status)` and `clear(operationId)`. The `status` value is an `OperationActivity` (`idle` | `running` | `awaiting` | `live` | `dormant`). The host uses this status to drive the running-panel perimeter rim / beacon.
- **Capability defaulting pattern (important invariant)**: `createClientCapabilities` provides **no-op default implementations** only for capabilities that need host state (`notifications`, `status`). The host overwrites these with store-bound real implementations in `core/host` via `createHostCapabilities`. The SDK therefore remains the contract plus no-op defaults; the host owns the stateful wiring. The SDK must not depend on `core/`, plugin packages, or `@dotobokuri/*`.
- Window state (maximize / minimize / active focus) is **host-owned chrome**, not part of the plugin contract. `OperationRenderContext` does not expose window state; minimize, maximize, and focus are handled by the host `OperationFrame`. Plugins render only their panel body and remain PTY- and window-state-agnostic.

## File Rules

- Keep TypeScript order as `imports -> types/interfaces -> constants -> functions`.
- Domain modules live under `operations`, `launch`, `terminal`, `plugin`, `settings`, `notifications`, `routing`, and `react`.
- Use `types.ts` for pure contracts, `browser.ts` for browser helpers, and `node.ts` for Node/plugin authoring helpers.
- Do not add `client` or `server` facade exports; consumers must import the domain subpath that matches their runtime.
