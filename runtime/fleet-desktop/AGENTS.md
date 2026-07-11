# Fleet Console Desktop

`runtime/fleet-desktop` is the optional thin Electron shell for Fleet Console.

## Directory index

| Directory | Responsibility |
|---|---|
| `src/` | Native app, window, menu, tray, and dialog lifecycle |
| `src/runtime/` | Managed Node and Console procurement and supervision |
| `assets/entry/` | Passive bootstrap status surface |
| `scripts/`, `build/` | Packaging and release policy |
| `tests/`, `e2e/` | Shell, ownership, packaging, and live runtime contracts |

## Constraints

- The Console product remains the sole server, PTY, provider, plugin, durable-state, and React owner. Desktop imports only `@dotobokuri/fleet-console/desktop-protocol`; never Console internals.
- The main process hands the single window to `/console/` only after verifying Desktop ownership and protocol for one exact loopback origin; the browser URL remains token-free.
- Every renderer remains sandboxed and Node-free. Navigation is confined to the activated Console origin's `/console/` paths; popups and non-Console navigation remain denied.
- The entry surface is view-only and one-way. Do not add preload, raw IPC, renderer input, a renderer fork, or a Desktop HTTP server; native dialogs are the input surface.
- Packaged artifacts remain shell-only; managed Node and Console code is procured into the replaceable Desktop runtime namespace, while state, captures, and locks remain in the Console data namespace.
- Managed Node procurement is staged, checksum-verified, and atomically promoted; installer and sidecar environments preserve their injection- and control-key sanitization.
- Stop only a protocol-verified Desktop-owned Console. A live foreign Console is acknowledged and left untouched.
- Never replace a running sidecar in place: updates found during an active app session trigger relaunch, and installation occurs only in the entry flow before handoff.
- Credential-free local packaging and signed release packaging are separate trust levels. Release paths fail closed, and signing claims require native release evidence.
