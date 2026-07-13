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

- The Console product remains the sole server, PTY, provider, plugin, durable-state, and React owner. Desktop production source imports the shared `@fleet-console/desktop-protocol` contract; never Console internals. Packaged integration tests remain anchored to the published `@dotobokuri/fleet-console/desktop-protocol` compatibility surface.
- The main process hands the single window to `/console/` only after verifying a loopback Console identity; the browser URL remains token-free. Desktop provenance stays lifecycle compatibility data, never a Console feature mode.
- Every renderer remains sandboxed and Node-free. Navigation is confined to the activated Console origin's `/console/` paths; popups and non-Console navigation remain denied.
- The entry surface is view-only and one-way. Do not add preload, raw IPC, a renderer fork, or a Desktop HTTP server. Runtime pairing input belongs only to Desktop's local sandboxed child modal: it contains no JavaScript and returns only its raw target through intercepted private-scheme navigation.
- Packaged artifacts remain shell-only; managed Node and Console code is procured into the replaceable Desktop runtime namespace, while state, captures, and locks remain in the Console data namespace.
- Managed Node and Console procurement is staged, checksum-verified, and atomically promoted; installer and sidecar environments preserve their injection- and control-key sanitization. In-session Console update application is only valid when it can preserve this contract and reconnect the owned window; otherwise Desktop relaunches into the entry-flow installer.
- Startup adopts only a protocol-compatible Console owned by the same Desktop. A foreign Console blocks startup and remains untouched; pairing with another runtime occurs only after handoff through an explicit native menu or tray action.
- Credential-free local packaging and signed release packaging are separate trust levels. Release paths fail closed, and signing claims require native release evidence.
