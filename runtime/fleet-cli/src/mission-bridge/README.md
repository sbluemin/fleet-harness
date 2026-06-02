# Mission Bridge

Mission Bridge owns the lower Fleet PTY domain for Fleet CLI.

`createMissionBridgeController()` assembles the lower-pane Fleet status line, Job Bar sections, Fleet PTY API, viewport component, and Job Bar subscription lifecycle. The composition root constructs it after Mission Control, calls `start()` at the existing Job Bar subscribe site, and calls `dispose()` during teardown at the existing unsubscribe site.

The controller exposes only:

- `component`
- `ptyApi`
- `jobBarState`
- `start()`
- `dispose()`

Generic controls primitives remain in `../controls/`: `panels.ts` owns the Fleet PTY panel API and `render.ts` owns the viewport adapter.
