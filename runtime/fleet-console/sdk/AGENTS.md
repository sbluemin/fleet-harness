# Fleet Console Plugin SDK Doctrine

`runtime/fleet-console/sdk` is the plugin-facing contract SSoT for Fleet Console. Core host, core client, and plugins may import it; the SDK must not import core, plugin packages, or `@dotobokuri/*`.

## Boundary

- The package name is `@fleet-console/sdk`.
- The package is private, source-only, and dependency-free except React as a peer.
- SDK modules define contracts and stateless authoring/browser helpers only.
- Server-side operation DTO sanitization stays in Fleet Console core and is intentionally excluded from SDK exports.
- Browser readback validators may live here, but they must only reject unsafe payloads already sanitized by core.

## Plugin Contract

- `OperationRenderContext` carries host-owned chrome state into the plugin render reactively: `theme` (`ConsoleTheme`: `maritime` | `carbon`). Plugins receive the theme in the render context and must consume it there; they must not read the core theme directly. Because the context is rebuilt when the canvas re-renders, theme changes are reflected immediately. Terminal-specific prefs (`renderer`, `font`) are not part of `OperationRenderContext`; the Terminal plugin owns them end-to-end via its own module-scoped store.
- `ClientOperationStatusCapability` lets a plugin report Operation activity: `set(operationId, status)` and `clear(operationId)`. The `status` value is an `OperationActivity` (`idle` | `running` | `awaiting` | `dormant`). The host uses this status to drive the running-panel perimeter rim / beacon: `running` (carrier streaming or agent turn in progress) and `awaiting` (waiting for operator input) animate the perimeter wake; `idle` and `dormant` render no perimeter animation. The beacon dot color follows the status — `running` = amber `--warn`, `awaiting` = aurora, `idle` = green `--positive`, `dormant` = brass.
- `ClientSettingsCapability` lets a plugin read and write per-server durable settings: `read(pluginId)` and `write(pluginId, value)`. Values are stored in the console `settings.json` under the `plugins` record and are persisted on the console server — they survive browser changes and console restarts. HTTP: `GET /api/v1/settings/plugins/:pluginId` (loopback gate) and `PUT /api/v1/settings/plugins/:pluginId` (origin-write gate). This is distinct from `ClientPreferencesCapability`, which is per-browser volatile (localStorage).
- **Capability defaulting pattern (important invariant)**: `createClientCapabilities` provides **no-op default implementations** only for capabilities that need host state (`notifications`, `status`). The host overwrites these with store-bound real implementations in `core/host` via `createHostCapabilities`. `settings` and `operations` are **pure HTTP implementations** in the SDK itself — they do **not** need host-side overrides and are **not** targets for `createHostCapabilities`. The SDK therefore remains the contract plus no-op defaults (for host-state capabilities) and HTTP implementations (for server-side capabilities); the host owns stateful wiring only for `notifications` and `status`. The SDK must not depend on `core/`, plugin packages, or `@dotobokuri/*`.
- Window state (maximize / minimize / active focus) is **host-owned chrome**, not part of the plugin contract. `OperationRenderContext` does not expose window state; minimize, maximize, and focus are handled by the host `OperationFrame`. Plugins render only their panel body and remain PTY- and window-state-agnostic.
- The SDK exposes authoring helpers that make plugin code easier to write, but these are stateless helpers and existing capability consumers only; they do **not** add new host capability surface:
  - Stateless UI components in `@fleet-console/sdk/settings/browser`: `SettingsCard`, `SettingsRow`, `SettingsToggle`, `SettingsSelect`, `SettingsField`.
  - `OperationBody` in `@fleet-console/sdk/operations/browser`.
  - Capability-consumer hooks in `@fleet-console/sdk/plugin/browser`: `usePluginApi`, `usePluginStorage`, `useOperationStatus` (setter-only), `usePluginSettings` (binds a `ClientSettingsCapability` to a fixed `pluginId`).
  - `PluginErrorBoundary` in `@fleet-console/sdk/react/browser`.
  - `SDK_API_VERSION` exported from `@fleet-console/sdk/version`, consumed through `FleetPluginManifest.apiVersion` for compatibility gating.
- `PluginInstallContext` and `OperationRenderContext` both expose `settings: ClientSettingsCapability` alongside the existing capabilities. `SettingsSectionDescriptor` stays minimal: `{ id, title, render }`.
- `RailPanelContext.pathContext` is required and contains `{ kind, relPath, label }`; `RailPanelDescriptor.pathAware` is an optional host-chrome opt-in. Plugins consume the resolved context but do not persist or select paths: selection is a host/server capability, not a plugin preference. Undeclared panels remain Theater-wide in host chrome.

## File Rules

- Keep TypeScript order as `imports -> types/interfaces -> constants -> functions`.
- Domain modules live under `operations`, `launch`, `plugin`, `settings`, `notifications`, `routing`, and `react`.
- Use `types.ts` for pure contracts, `browser.ts` for browser helpers, and `node.ts` for Node/plugin authoring helpers.
- Do not add `client` or `server` facade exports; consumers must import the domain subpath that matches their runtime.
