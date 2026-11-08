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

- The Console product remains the sole server, PTY, provider, plugin, durable-state, and React owner. Desktop production source imports only the shared `@fleet-console/protocol` contracts (`desktop`, `lifecycle`, `release`, `remote`) and the leaf foundation packages `@fleet-console/process` and `@fleet-console/lifecycle`; never Console internals. Packaged integration tests remain anchored to the published `@dotobokuri/fleet-console/desktop-protocol` compatibility surface.
- Startup launches the managed Console and hands the single window to its `/console/`. Desktop offers no surface for choosing, adding, or naming a Console — that belongs to the Console product, and a second copy of it here would split the list a user sees. For the Console's sidebar section, Desktop only relays the minimized directory and bounded commands that the Console security constraints define, resolves each command's window-owned opaque id against the home Console, and asks for native confirmation before forgetting a saved Console.
- The main process hands the window to `/console/` only after verifying the target's Console identity, and to a remote origin only after confirming its live certificate against the fingerprint the local Console holds for it — confirmed over a plain socket first, because Chromium caches a failed verdict for the whole app run. The browser URL remains token-free: a credential travels in a main-process request body, never in a URL the renderer loads. Desktop provenance stays lifecycle compatibility data, never a Console feature mode.
- Every renderer remains sandboxed and Node-free. Navigation is confined to the `/console/` paths of admitted Console origins — loopback, plus each remote origin whose certificate was confirmed; non-Console navigation and general popups remain denied. Withdrawing a remote origin also clears it from the active origin, and a certificate pin narrows trust to one host without widening it for any other.
- The sole Browser detach exception is one passive, exact-path companion document in the active Console's origin and session, authorized by a current, single-use Console intent and verified main-frame provenance. It opens no further windows and navigates nowhere else. Console remains the single UI, state, and content-bounds owner; Desktop only hosts the named surface and reparents existing native views. Companion close returns that surface to Console; renderer replacement, Console/control withdrawal, and main-window shutdown revoke its intent and dispose its resources without reviving the main window. This exception grants no new origin or blanket permission.
- This computer's font list goes to the loopback Console's main frame without asking, and to an admitted remote Console only after the user allows that origin in a native dialog. Allow and deny answers live in memory for the app run, so a remote page cannot re-prompt; never grant `unknown` or other permissions wholesale.
- The entry surface is view-only and one-way. Do not add preload, raw IPC, a renderer fork, a renderer framework, or a Desktop HTTP server.
- Remote access lives in Desktop only as headless plumbing: the certificate pin, the origin admission, and the join exchange. Which console to open and what to trust are read from the local Console; Desktop never parses an access link, never stores a host, and writes no credential of its own — the pairing a remote console grants lives in the window session's own cookie jar, and Desktop joins on every open so a paired device resumes without a new link. The registered `fleet://` scheme forwards its raw argument to the local Console and does nothing else with it.
- Where a Console menu covers a native Browser view, the shell may show one reusable, non-focusable transparent child window of the owning Console surface at the place the Console snapshot names, holding only the Console-owned float page in that surface's session; it navigates nowhere else, opens nothing, and its content and actions pass between the two Console renderers, never through the shell.
- The Fleet Browser's native views follow the Desktop host to whichever Console it shows, a joined remote Console included: that Console's agent then drives Chromium on this machine, by product decision. Each view lives in its own session partition, never in a Console window's cookie jar, and only the Desktop host that holds control of a Console hosts that Console's views, reparented rather than duplicated between its admitted surfaces.
- Packaged artifacts remain shell-only; managed Node and Console code is procured into the replaceable Desktop runtime namespace, while state, captures, and locks remain in the Console data namespace.
- Managed Node and Console procurement is staged, checksum-verified, and atomically promoted; installer and sidecar environments preserve their injection- and control-key sanitization. In-session Console update application is only valid when it can preserve this contract and reconnect the owned window; otherwise Desktop relaunches into the entry-flow installer.
- Startup adopts only a protocol-compatible Console owned by the same Desktop; a foreign Console blocks the launch and remains untouched.
- Credential-free local packaging and signed release packaging are separate trust levels. Release paths fail closed, and signing claims require native release evidence.
