# Fleet Console Desktop

`runtime/fleet-desktop` is the optional thin Electron shell for Fleet Console.

## Directory index

| Directory | Responsibility |
|---|---|
| `src/` | Native app, window, menu, tray, and dialog lifecycle |
| `src/runtime/` | Managed Node and Console procurement and supervision |
| `assets/entry/` | Passive bootstrap status surface |
| `scripts/`, `build/` | Packaging and release policy |
| `tests/` | Shell, ownership, packaging, and live runtime contracts |

## Constraints

- The Console product remains the sole server, PTY, provider, plugin, durable-state, and React owner. Desktop production source imports the shared `@fleet-console/desktop-protocol` contract; never Console internals. Packaged integration tests remain anchored to the published `@dotobokuri/fleet-console/desktop-protocol` compatibility surface.
- The main process hands the single window to `/console/` only after verifying the target's Console identity, and for a remote target only after confirming its certificate against the fingerprint its access link carries. The browser URL remains token-free: a credential travels in a main-process request body, never in a URL the renderer loads. Desktop provenance stays lifecycle compatibility data, never a Console feature mode.
- Every renderer remains sandboxed and Node-free. Navigation is confined to the `/console/` paths of admitted Console origins — loopback, plus each remote origin whose certificate was confirmed; popups and non-Console navigation remain denied. Withdrawing a remote origin also clears it from the active origin, and a certificate pin narrows trust to one host without widening it for any other.
- The entry surface is view-only and one-way. Do not add preload, raw IPC, a renderer fork, or a Desktop HTTP server. Runtime pairing input belongs only to Desktop's local sandboxed child modal: it contains no JavaScript and returns only its raw target through intercepted private-scheme navigation. That modal suppresses the parent's menu accelerators, so it must carry the editing commands macOS routes through those same accelerators — otherwise its fields cannot be pasted into.
- Packaged artifacts remain shell-only; managed Node and Console code is procured into the replaceable Desktop runtime namespace, while state, captures, and locks remain in the Console data namespace.
- Managed Node and Console procurement is staged, checksum-verified, and atomically promoted; installer and sidecar environments preserve their injection- and control-key sanitization. In-session Console update application is only valid when it can preserve this contract and reconnect the owned window; otherwise Desktop relaunches into the entry-flow installer.
- Startup asks which Console to connect to before it procures or adopts anything, and the answer is never remembered — a runtime is chosen, not inherited. Choosing the managed local runtime adopts only a protocol-compatible Console owned by the same Desktop; a foreign Console blocks that choice and remains untouched. Pairing input at startup and afterwards uses the same sandboxed child modal, reachable later through an explicit native menu or tray action.
- Credential-free local packaging and signed release packaging are separate trust levels. Release paths fail closed, and signing claims require native release evidence.
