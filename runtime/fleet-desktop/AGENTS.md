# Fleet Console Desktop

`runtime/fleet-desktop` is the optional thin Electron shell for Fleet Console.

## Directory index

| Directory | Responsibility |
|---|---|
| `src/` | Native app, window, menu, tray, and dialog lifecycle |
| `src/runtime/` | Managed Node and Console procurement and supervision |
| `assets/entry/` | Passive bootstrap status surface |
| `scripts/`, `build/` | Packaging and release policy |
| `tests/` | Shell, ownership, packaging, and runtime contracts |

## Constraints

- The Console product remains the sole server, PTY, provider, plugin, durable-state, and React owner. Desktop production source imports the shared `@fleet-console/desktop-protocol` contract; never Console internals. Packaged integration tests remain anchored to the published `@dotobokuri/fleet-console/desktop-protocol` compatibility surface.
- Startup launches the managed Console and hands the single window to its `/console/`. Desktop offers no surface for choosing, adding, or naming a Console — that belongs to the Console product, and a second copy of it here would split the list a user sees.
- The main process hands the window to `/console/` only after verifying the target's Console identity, and to a remote origin only after confirming its live certificate against the fingerprint the local Console holds for it — confirmed over a plain socket first, because Chromium caches a failed verdict for the whole app run. The browser URL remains token-free: a credential travels in a main-process request body, never in a URL the renderer loads. Desktop provenance stays lifecycle compatibility data, never a Console feature mode.
- Every renderer remains sandboxed and Node-free. Navigation is confined to the `/console/` paths of admitted Console origins — loopback, plus each remote origin whose certificate was confirmed; popups and non-Console navigation remain denied. Withdrawing a remote origin also clears it from the active origin, and a certificate pin narrows trust to one host without widening it for any other.
- The entry surface is view-only and one-way. Do not add preload, raw IPC, a renderer fork, a renderer framework, or a Desktop HTTP server.
- Remote access lives in Desktop only as headless plumbing: the certificate pin, the origin admission, and the grant exchange. Which console to open and what to trust are read from the local Console; Desktop never parses an access link, never stores a host, and never keeps a credential. The registered `fleet://` scheme forwards its raw argument to the local Console and does nothing else with it.
- Packaged artifacts remain shell-only; managed Node and Console code is procured into the replaceable Desktop runtime namespace, while state, captures, and locks remain in the Console data namespace.
- Managed Node and Console procurement is staged, checksum-verified, and atomically promoted; installer and sidecar environments preserve their injection- and control-key sanitization. In-session Console update application is only valid when it can preserve this contract and reconnect the owned window; otherwise Desktop relaunches into the entry-flow installer.
- Startup adopts only a protocol-compatible Console owned by the same Desktop; a foreign Console blocks the launch and remains untouched.
- Credential-free local packaging and signed release packaging are separate trust levels. Release paths fail closed, and signing claims require native release evidence.
