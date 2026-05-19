# Fleet PTY

`src/tui/pty/fleet/api.ts` is the only external Fleet PTY entrypoint for overlays and region replacement.

Consumers must not import `region-stack.ts`, `overlay-manager.ts`, `sections.ts`, or `types.ts` directly. The default behavior is default region -> overlay push -> overlay pop -> previous/default region.

## Contracts

- `component.ts` defines the local `Component` and `Focusable` contract.
- `theme.ts` provides local ANSI style helpers.
- `keys.ts` provides the key matching subset used by carrier-status overlays.
- `frame.ts` renders width-safe lower-pane overlay frames using local cell-width helpers.
- `local-ui.ts` adapts terminal size, focus, render requests, and input listeners for `custom<T>`.
- `api.ts` exposes `custom<T>`, stack wrappers, section mounting, desired-height access, resize hooks, and read-only active-region helpers.

`custom<T>` calls the factory, mounts its returned component, routes Fleet PTY input to `handleInput`, resolves from `done(result)`, disposes on close, and returns to the default composite region.

Fleet PTY desired-height measurement is pure: components return a requested row count and the manager decides the final vertical split with `MIN_DEDICATED_ROWS`.

Fleet PTY does not own PTY lifecycle, raw keyboard routing, or child process control; those stay in `src/tui/pty/dedicated/**` and `src/input/**`.
