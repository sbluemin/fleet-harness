# Fleet Console Plugin SDK

`runtime/fleet-console/sdk` is the source-only contract boundary shared by Console core and plugins.

## Directory index

| Directory | Responsibility |
|---|---|
| `operations/`, `launch/`, `plugin/` | Operation and plugin lifecycle contracts |
| `settings/`, `notifications/` | Configuration and notification capabilities |
| `routing/`, `rail/` | Route and host-panel integration contracts |
| `react/` | Stateless React authoring helpers |

## Constraints

- Core and plugins may depend on SDK; SDK must not depend on Console core, plugin packages, or `@dotobokuri/*`.
- SDK contains contracts, validators, and stateless or runtime-specific helpers. Server-side DTO sanitization remains in Console core.
- Window chrome, Operation state, and path selection are host-owned. Plugins receive resolved context and render their bodies only.
- Preferences are browser-local and volatile; settings are server-durable. Neither channel is a credential or raw-path store.
- Pure HTTP capabilities stay SDK-owned; Console supplies only implementations that require host client state.
- Consumers import the domain/runtime subpath they need. Do not add broad client or server facade exports.
