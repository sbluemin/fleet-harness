# Fleet PTY

`@dotobokuri/fleet-tui/pty` is the only external Fleet PTY entrypoint for overlays and region replacement.

Consumers must not import `region-stack.ts`, `overlay-manager.ts`, `types.ts`, or other Fleet PTY internals directly. The default behavior is host-composed default region -> overlay push -> overlay pop -> previous/default region.

## Contracts

- `component.ts` defines the local `Component` and `Focusable` contract.
- `theme.ts` provides local ANSI style helpers.
- `keys.ts` provides the key matching subset used by carrier-status overlays.
- `frame.ts` renders width-safe lower-pane overlay frames using local cell-width helpers.
- `local-ui.ts` adapts terminal size, focus, render requests, and input listeners for `custom<T>`.
- `api.ts` exposes `custom<T>`, stack wrappers, section mounting, desired-height access, resize hooks, frame/theme/key/cell-width helpers, and read-only active-region helpers.

`custom<T>` calls the factory, mounts its returned component, routes Fleet PTY input to `handleInput`, routes local mouse events to optional `handleMouse`, resolves from `done(result)`, disposes on close, and returns to the default composite region.

Mouse events are generic SGR-derived events with 1-based local pane coordinates. The default Fleet PTY region consumes mouse events as no-op so lower-pane wheel input never leaks into the Dedicated PTY.

Fleet PTY desired-height measurement is pure: components return a requested row count and the manager decides the final vertical split with `MIN_DEDICATED_ROWS`.

Fleet PTY does not own host default content or mode policy. Default content and host modes stay in consuming host packages.

Generic keyboard and mouse token routing stays in `@dotobokuri/fleet-tui/input`.

Dedicated CLI PTY infrastructure stays in `@dotobokuri/fleet-tui/pty`.
