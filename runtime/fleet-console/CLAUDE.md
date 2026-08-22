# Fleet Console

`runtime/fleet-console` is the sole published host for Fleet Console and the `fleet` terminal launcher. The Console product — core plus built-ins under `../fleet-plugins/` — owns Console HTTP, streaming, PTY/provider/plugin runtime, durable state, and browser UI; `cli/` owns the thin Claude Code launcher and shared auth/update commands.

## Directory index

| Directory | Responsibility |
|---|---|
| `cli/` | Dual-entry `fleet` launcher (auth/update/console/cli passthrough) and thin Claude gateway |
| `core/host/` | Server lifecycle, security, durable state, and core APIs |
| `core/client/` | React application, host chrome, and browser state |
| `desktop-protocol/` | Shared Console-Desktop protocol contract |
| `sdk/` | Plugin-facing contracts and stateless helpers |
| `markdown/` | Shared sanitized markdown and diagram rendering |
| `font-picker/` | Shared controlled font-selection surface |
| `tests/` | Service, security, state, and integration contracts |
| `../fleet-plugins/` | Built-in plugin implementations |
| `../fleet-desktop/` | Optional thin native shell |

## Domain boundaries

- A **Theater** is any registered project root. An **Operation** is a Console-managed unit inside a Theater. A Codex workspace is the subset of a Theater or selected path that contains Fleet Wiki knowledge.
- Console owns Theater and Operation state, window chrome, path selection, security gates, and plugin registries. Plugins own their panel bodies and plugin-scoped runtime behavior.
- Desktop may supervise and display Console only through the public desktop protocol; it must not duplicate server, PTY, provider, plugin, state, or React behavior.
- Host code may consume public APIs from lower-layer Fleet packages, but must not import any package's implementation paths. Browser code remains Node-free. SDK dependencies point from host, client, and plugins into SDK, never back into core or plugin implementations.
- Built-ins are trusted static plugins. Installing an external plugin grants same-process Node and same-origin browser privileges; external plugins are not sandboxed.

## Security and state constraints

- The loopback listener's core browser APIs do not use bearer, admin, MCP, or session tokens. Loopback is not authorization: preserve route-specific Host and Origin gates.
- A remote listener is the opposite default: every request it accepts requires a session, decided once before routing, and the only exception is the join endpoint. That endpoint is the one unauthenticated door on a public address, so it carries a failure budget per source and a global cap on concurrent attempts; the count of rejected attempts is reported to the owner rather than kept silent. Pairing happens only in the dedicated apps - a browser cannot check this console's certificate fingerprint - so the listener serves no browser-facing surface, not even an explanatory one. Sessions are bound to the listener that issued them and never cross between loopback and remote.
- A session is an open connection; a pairing is the standing permission behind it, and the two never collapse into one. A single-use grant from an access link creates a pairing; after that the paired device reopens a session on its own, so ending a session — by reclaiming control, by idling out, or by restarting the console — never costs that device its way back. Unpairing and a new certificate do, and so does a device that stays away longer than the cookie carrying its secret: browsers cap that lifetime well below the certificate's, so each return renews it and only a dormant device ages out. Console stores a pairing's hash, never its secret, and the device carries the secret in a cookie the console sets. Many devices may be paired, but the remote listener holds one session at a time whatever its access class, because one console is one screen and one terminal: a join supersedes the open session instead of being refused, the displaced device is told its session ended for that reason rather than that control was reclaimed, and its pairing survives so it returns by joining again.
- A link publishes an address as much as a credential, and a device keeps only what the link told it. So the remote listener remembers the port it first opened on and reopens that one, rather than following the console's own port, which is free to move on every start; it never slides to another port on its own, because a device that cannot find the address it was given is unpaired in fact while the list still says otherwise. Releasing that port belongs with the acts that already void every pairing.
- Console owns which other consoles this one can reach, and that list is reachable only from the loopback listener — a remote session must not enumerate or edit the addresses and certificate pins of third machines. A saved host stores where to go and what certificate to trust, never a credential; a link's single-use grant lives in memory until the shell takes it, and is handed over exactly once.
- Terminal WebSocket is the sole ticketed browser transport: an Origin-authorized HTTP route issues a short-lived one-use ticket consumed by the upgrade. Do not generalize that ticket into browser bearer authentication.
- Provider session identities, transcripts, and raw filesystem paths may remain in sensitive server-side state but must not enter ordinary core or built-in browser DTOs, browser-visible logs, streams, or static assets.
- Local-channel environment diagnostics invoked only by an explicit user action may return the Console's own data-root and runtime-lock paths, and the Agent CLI executable paths a user configured together with the PATH entries searched to resolve them.
- Filesystem access requires lexical validation followed by containment checks on resolved real paths. Git revision input must reject option-like arguments even when no shell is used.
- Shared markdown and Mermaid output must remain sanitized before DOM insertion; Mermaid stays strict with HTML labels disabled, and renderer-supplied bind functions are never executed.
- The Console server is the sole durable-state writer. Development and published channels intentionally use separate data roots; an explicit Console-directory override relocates runtime and durable data together. Restored Operations are dormant until explicitly relaunched.
- Within core folder-selection APIs, explicit browsing and grant responses are the only browser payloads permitted to carry selected absolute paths.

## Design invariants

- Every color speaks on exactly one channel: signal tokens (`aurora`/`warn`/`coral`/`positive`) carry state only, `brass` carries location and focus only, and user or agent identity uses the `--id-*` tones painted exclusively as marks (caption nameplate, rail-chip spine, minimap dot) — borders stay state-owned and identity never repaints signal surfaces or the unfocused caption fill.
- Interaction state is carried by form, not by one colour at four strengths: hover is a neutral surface (`--surface-hover`), selection is a raised surface (`--surface-select` + `--elev-select`), current location is a spine, and keyboard focus is the single ring (`--ring-shadow`). No surface reinvents a focus outline or paints selection as a brass fill; the segmented control has exactly one implementation, the SDK `Segmented`.
- Core and built-in plugin CSS consume colors only as theme tokens via `var()`/`color-mix`; chromatic raw literals live solely in `theme.css` token definitions so all three themes retune together. Near-achromatic shadow, scrim, and sheen literals that carry depth rather than hue are the sanctioned exception.
- `tests/instrument-design-contract.test.ts` pins the design grammar: a legitimate grammar change updates the contract together with the change, and intentional exceptions are recorded as doctrine comments beside the exempted CSS rule.

## Distribution constraints

- Console serves its own web build and owns both published bins (`fleet`, `fleet-console`); there is no second Console web/HTTP owner. The `fleet` entry may still run an AI Gateway listener of its own — ephemeral for Claude Code passthrough, or explicitly long-lived under `fleet gateway serve` — always bound to loopback, never a Console web/HTTP surface, and never authenticated.
- Published Console artifacts are self-contained: workspace packages are bundled and must not survive as workspace-version dependencies.
- The published `./desktop-protocol` subpath is a compatibility surface for shipped Desktop shells under always-latest Console installs; keep its export surface unchanged.
- Host and built-in plugin bundles may load separate copies of a module. Never coordinate across that boundary through module-scoped singleton state.
- Built-in plugin server code must resolve package-level native or external dependencies from the Console package rather than the generated plugin cache; validate the affected path against the built distribution because source tests and builds can stay green.
