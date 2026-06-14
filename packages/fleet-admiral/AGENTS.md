# fleet-admiral Doctrine

`packages/fleet-admiral` owns Fleet Admiral prompt policy, protocol text, standing orders, Fleet-specific default tool catalog wiring, Agent CLI launch/runtime policy, Fleet plugin/persona rendering, and Fleet-specific in-process MCP runtime assembly.

## Owns

- Admiral system prompt assembly and the `createSystemPromptBuilder(deps): SystemPromptBuilder` factory
- Protocol gate prompt policy, protocol skill doctrine, and standing-order prompt policy
- Standing orders used by the Admiral system prompt
- Fleet-specific agent tool defaults and whitelist-only executor MCP tool exposure
- Agent CLI launch spec building: profile resolution, provider args/env/cwd construction, binary resolution, and Fleet activation arguments
- Fleet plugin/persona rendering for built-in Fleet assets, user-global `~/.fleet`, and project `.fleet` activation surfaces
- Fleet-specific in-process MCP server assembly and executor session/token issuance using `@dotobokuri/core-agent` primitives

## Must Not Own

- Host UI, PTY, render lifecycle, panels, actual Agent CLI process spawn, native passthrough, terminal tickets, browser payloads, or pane behavior
- Generic reusable MCP HTTP/JSON-RPC primitives, schema conversion primitives, browser-facing MCP transport, or host-specific token exposure
- Fleet Wiki UI, Fleet Infra implementation, fleet-cli composition-root wiring, fleet-console server/browser lifecycle, or host logging/telemetry channels

## Import Boundaries

- May depend on `@dotobokuri/fleet-carriers` and `@dotobokuri/core-agent`.
- Must not import `@dotobokuri/fleet-cli`, `@dotobokuri/fleet-wiki`, `@dotobokuri/fleet-console`, `@dotobokuri/fleet-infra`, `runtime/fleet-cli`, `node-pty`, `ws`, or host process-spawn adapters.
- Fleet Infra capabilities such as auth resolution, data-dir selection, durable advisory locks, and filesystem services enter only through explicit `create*(deps)` dependency objects supplied by hosts.
- Codex command execution, hook executable commands, workspace scanners, and optional Fleet Wiki tool specs enter only through explicit host DI.
- Consumers import only from the root package entry `@dotobokuri/fleet-admiral`; do not add subpath exports or deep-import compatibility paths.

## Public Surface

The root barrel is whitelist-only. It may export exactly the existing prompt/tool exports plus the approved Agent CLI runtime exports listed in `.fleet/plans/admiral-agent-runtime.md` and the carrier-result reminder endpoint exports (`PtyWriteSink`, `createCarrierResultReminderRouter`, `sanitizeCarrierResultReminder`, `formatCarrierResultReminderMessage`) approved in `.fleet/plans/console-carrier-reminder.md`. Do not use `export *`, subpath exports, or deep-import compatibility paths.

## DI Factory Discipline

Injectable services use explicit pure factories:

```ts
createThing(deps): ThingInterface
```

Do not introduce DI containers, service locators, hidden host lookups, or module-level mutable runtime state.
