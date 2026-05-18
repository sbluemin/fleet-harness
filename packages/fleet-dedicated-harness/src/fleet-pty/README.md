# Fleet PTY

`fleet-pty/api.ts` is the only external Fleet PTY entrypoint for overlays and region replacement.

Consumers must not import `region-stack.ts`, `overlay-manager.ts`, `sections.ts`, or `types.ts` directly. The default behavior is default region -> overlay push -> overlay pop -> previous/default region.

`fleet-pty/` does not own PTY lifecycle, raw keyboard routing, or child process control; those stay in `pty/` and `input/`.
