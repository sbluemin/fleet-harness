# Terminal Plugin Doctrine

`runtime/fleet-plugins/terminal` owns the built-in Fleet Console Terminal plugin.

## Settings Ownership

- The Terminal plugin owns `/plugins/terminal/settings`.
- `GET /plugins/terminal/settings` returns the Terminal prompt settings DTO. Loopback host validation is enforced by the upstream console host gate before plugin route dispatch.
- `PUT /plugins/terminal/settings` requires the terminal Origin authorization gate and updates only Terminal prompt settings.
- The Terminal plugin owns one Settings section: `Agent CLI`.
- The `Agent CLI` Settings section renders exactly four blocks in order: System Prompt, Agent CLI Available, Terminal Font, and Terminal Renderer.
- `Agent CLI` owns `enableMetaphor` UI controls for Terminal-launched agent sessions.
- Prompt settings persist through `@dotobokuri/fleet-infra` global options in `~/.fleet/settings.json`. Do not move these settings into plugin storage.
- Terminal Font and Terminal Renderer settings are Terminal plugin-owned end-to-end: state, persistence, UI, and consumption all live in the plugin. Core/client must not touch these values.
- **Terminal Font** (name + size) is persisted on the console server under `plugins.terminal.font` via `ClientSettingsCapability` (`/api/v1/settings/plugins/terminal`). This survives browser changes and console restarts. **Terminal Renderer** remains in localStorage under `fleet-plugin.terminal.renderer` — do not move it to server storage.
- On first load the store attempts to hydrate font from the server. If the server has no value but `fleet-plugin.terminal.font` exists in localStorage, the local value is seeded to the server via a single PUT and the localStorage key is deleted (1-time migration, idempotent — if the server already has a value on any subsequent load, the local key is deleted without re-seeding). Legacy keys (`fleet-console.terminalRenderer`, `fleet-console.terminalFont`) are migrated once on first access to the new namespace keys before server hydration.
- **Hydration race guard**: if the user calls `setTerminalFont*`/`setTerminalFontSize` while a server `read` is still pending, the `fontWriteEpoch` counter is bumped and the hydration result is discarded on resolve — the user's explicit write always wins.
- All prefs state is module-scoped in `client/shared/terminal-prefs-store.ts` and subscribed via `useSyncExternalStore`. Every mounted terminal panel (active, inactive, dormant) reacts instantly to settings card changes.
