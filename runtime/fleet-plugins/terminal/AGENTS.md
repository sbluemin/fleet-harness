# Terminal Plugin Doctrine

`runtime/fleet-plugins/terminal` owns the built-in Fleet Console Terminal plugin.

## Settings Ownership

- The Terminal plugin owns `/plugins/terminal/settings`.
- `GET /plugins/terminal/settings` returns the Terminal prompt settings DTO. Loopback host validation is enforced by the upstream console host gate before plugin route dispatch.
- `PUT /plugins/terminal/settings` requires the terminal Origin authorization gate and updates only Terminal prompt settings.
- The Terminal plugin owns `/plugins/terminal/model-auth`.
- The Terminal plugin owns the model-auth provider whitelist and state builder.
- `GET /plugins/terminal/model-auth/state` returns the display-safe model sign-in DTO built by the Terminal plugin. Loopback host validation is enforced by the upstream console host gate before plugin route dispatch.
- `PUT /plugins/terminal/model-auth/providers/:cli` and `DELETE /plugins/terminal/model-auth/providers/:cli` require the terminal Origin authorization gate and mutate provider API keys through `@dotobokuri/fleet-infra` auth storage.
- The Terminal plugin owns one Settings section: `Agent CLI`.
- The `Agent CLI` Settings section renders exactly five blocks in order: System Prompt / Metaphor, Model Sign-in, Agent CLI Available, Terminal Font, and Terminal Renderer.
- `Agent CLI` owns `replaceSystemPrompt` and `enableMetaphor` UI controls for Terminal-launched agent sessions.
- Prompt settings persist through `@dotobokuri/fleet-infra` global options in `~/.fleet/settings.json`. Do not move these settings into plugin storage.
- Model sign-in persists through `@dotobokuri/fleet-infra` auth service in `~/.fleet/auth.json`. Do not move API keys into plugin storage or browser payloads.
- Terminal Font and Terminal Renderer settings are Terminal plugin-owned end-to-end: state, persistence, UI, and consumption all live in the plugin. Core/client must not touch these values.
- **Terminal Font** (name + size) is persisted on the console server under `plugins.terminal.font` via `ClientSettingsCapability` (`/api/v1/settings/plugins/terminal`). This survives browser changes and console restarts. **Terminal Renderer** remains in localStorage under `fleet-plugin.terminal.renderer` — do not move it to server storage.
- On first load the store attempts to hydrate font from the server. If the server has no value but `fleet-plugin.terminal.font` exists in localStorage, the local value is seeded to the server via a single PUT and the localStorage key is deleted (1-time migration, idempotent — if the server already has a value on any subsequent load, the local key is deleted without re-seeding). Legacy keys (`fleet-console.terminalRenderer`, `fleet-console.terminalFont`) are migrated once on first access to the new namespace keys before server hydration.
- **Hydration race guard**: if the user calls `setTerminalFont*`/`setTerminalFontSize` while a server `read` is still pending, the `fontWriteEpoch` counter is bumped and the hydration result is discarded on resolve — the user's explicit write always wins.
- All prefs state is module-scoped in `client/shared/terminal-prefs-store.ts` and subscribed via `useSyncExternalStore`. Every mounted terminal panel (active, inactive, dormant) reacts instantly to settings card changes.

## Scrollback Tail Route (Bench Consumer Contract)

- `GET /plugins/terminal/agent/sessions/:sessionId/scrollback?lines=N` — returns `{ scrollback: string, bytes: number, truncated: boolean }`.
- **Authorized consumer**: bench plugin only. No other plugin or client surface should call this route.
- Response contains **stdout bytes only**. `ticket`, `token`, `providerSession`, `transcriptPath`, `canonicalCwd`, and all other sensitive fields must never appear in the response body.
- `lines` query parameter is clamped to [1, 200]. Byte upper bound is 32,768 (32 KB) from the scrollback ring.
- Implemented in `server/agent-api/scrollback-route.ts`, dispatched from `server/agent.ts` handle function, no explicit auth gate beyond the loopback host gate enforced upstream.

## Pending Initial-Input Queue (Bench Fan-out Contract)

- `POST /plugins/terminal/agent/sessions` accepts an optional `initialInput?: string` field in the request body.
- **Token Boundary**: `initialInput` is **never included** in the session create response payload (`SessionInfo`). It is consumed server-side only.
- Delivery strategy is determined per-CLI via `resolveInitialInputMode(cliId)` in `server/agent-api/initial-input-mode.ts`:

| CLI id       | Mode   | Delivery mechanism                                   |
|--------------|--------|------------------------------------------------------|
| `claude`     | `argv` | Appended as final positional arg at spawn time       |
| `claude-kimi`| `argv` | Appended as final positional arg at spawn time       |
| `claude-glm` | `argv` | Appended as final positional arg at spawn time       |
| `codex`      | `write`| Quiescence-based `terminalRuntime.write` (see below) |
| unknown      | `write`| Quiescence-based write (safe fallback)               |

- **argv mode (claude family)**: `initialInput` flows through `TerminalLaunchContext.initialInput` → `createAgentCliLaunchSpec` → `toLaunchSpec`, where it is appended to `profile.args` before PTY spawn. No queue involvement.
- **write mode (codex / unknown)**: `createPendingInitialInputQueue` (in `server/agent-api/pending-initial-input.ts`) uses output-quiescence detection. On each PTY stdout event the settle timer (700 ms) resets; after no output for 700 ms the text is written, followed by `\r` (CR) 250 ms later. A hard cap of 8 s forces flush if output never arrives.
- The queue is disarmed on session exit, error, or explicit `disarm(sessionId)` call, and cleaned up via `cleanup()` on plugin lifecycle shutdown. `pendingArgvInitialInput` map in `agent.ts` is also cleared on cleanup, session exit, and error.
- **Security note**: argv positional injection passes the prompt as a process argument visible in `ps` output. This is intentional for claude CLIs which accept the first turn as a positional; it must not be used for CLIs that do not advertise this interface.
