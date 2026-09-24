# Fleet Development Reference Guide

## 1. Architectural Split

Fleet Console is the sole published owner of the CLI launcher and web product. Private workspace identities are implementation boundaries, not separately published products.

- `runtime/fleet-console/cli/` owns argv/process lifecycle and thin Claude Code passthrough.
- `runtime/fleet-console/core/host/` owns bootstrap, transport, plugin adapters, and native-shell composition.
- `runtime/fleet-console/core/client/src/` owns app composition, chrome, and integration.
- `runtime/fleet-console/features/` owns Execution, AI Gateway, Analyst, Console Use, Browser, Computer Use, Remote Access, Workspace, Settings, and Updates.
- `runtime/fleet-console/foundation/` owns Agent runtime, process/infra primitives, Markdown, and Font Picker.
- `runtime/fleet-console/sdk/` and `protocol/` own plugin and shell contracts.
- Built-ins remain under `runtime/fleet-plugins/`; Wiki belongs to Codex, not CLI injection.
- Desktop and Mobile remain thin shells; Desktop does not duplicate Console runtime or UI.

## 2. Where New Work Goes

Put a product capability's state, routes, runtime, and UI with its feature. Optional `host/`, `client/`, `runtime/`, and `contracts/` directories follow actual ownership; do not create empty layers. Core assembles producers and consumers through explicit dependencies. Generic or reusable mechanisms belong in foundation, including shared Fleet execution policy when it does not import product features.

Updates owns version/registry primitives and its UI/API; CLI, Console, and Desktop retain their own process shutdown, runtime procurement, lock, and restart responsibilities. Remote Access owns pairing, sessions, control, saved hosts, and remote listener policy, not every security mechanism.

## 3. Import Rules

- Foundation must not import feature, core, CLI, or plugin implementations or contracts.
- Agent substrate (`tools`, `mcp`, `claude`) must not import Fleet execution policy (`fleet`). Gateway model meanings and delegation registrations arrive through explicit ports.
- Consume private workspace packages through declared exports; never deep-import another package's source.
- Keep headless runtime imports free of UI/host startup side effects. Browser graphs remain Node-free.
- Core coordinates durable state through one writer and composes plugin capability adapters. Avoid mutable shared capability bags, DI containers, and service locators.
- Published Console bins and `./cli`, `./desktop-protocol`, `./access-protocol` exports remain compatible. Private package renames do not change HTTP/MCP/storage identities.

## 4. State Synchronization

Fleet supports multiple concurrent instances sharing the same durable state files via the `fs-store` advisory directory lock (`withDirectoryLock`) combined with atomic writes and read-time snapshots. Developers must avoid hidden process-global state and use explicit service instances plus pull-based resolvers.

## 5. Isolated Development Data

Everything a user chooses in a Console — settings, credentials, AI Gateway selection, the rendered Claude harness tree, and accumulated workspace knowledge — belongs to that Console instance and lives in its slot, `<fleet-data-root>/console` by default. The Fleet data root itself holds only what is shared across hosts: the update check and the `computer-use/` and `desktop/` host directories. `pnpm fleet`, `pnpm console`, and `pnpm desktop` run through `scripts/run-isolated.mjs`, which points all three at one checkout-local root so a development run cannot read or overwrite the user's own environment:

| Variable | Development value | Owns |
|---|---|---|
| `FLEET_DATA_DIR` | `<checkout>/.fleet/isolated` | The data root: host-shared directories, and the default parent of the Console slot |
| `FLEET_CONSOLE_DATA_DIR` | `<checkout>/.fleet/isolated/console` | The Console slot: settings, credentials, AI Gateway selection, harness tree, workspaces, durable state, runtime lock |
| `FLEET_DESKTOP_DATA_DIR` | `<checkout>/.fleet/isolated/desktop` | Desktop owner identity and Electron user data |

Two Console instances that share a data root still get separate slots when they run on different channels or from different checkouts, so each keeps its own selection and login. The `fleet` launcher resolves the slot by the same rule as the Console server, which is what lets `fleet gateway` read what the Console was told to expose. Values left at the previous location are carried over once, on first access, and the old file is removed with them, so one place holds the answer. A file that cannot be read blocks the write that would strand it rather than silently starting empty, and a previous location that resolves to the destination itself is never treated as a source.

`pnpm fleet` runs this checkout's built `fleet` launcher, so every command the installed binary accepts works against the isolated root — `pnpm fleet gateway status`, `pnpm fleet --help`, `pnpm fleet console status`. It runs the build output, so build once before using it. `pnpm cli` remains as the former name of the same target.

Because the root is isolated, a development run starts with no credentials, no installed marketplace plugins, and no accumulated workspace knowledge — that is the point of the isolation, not a defect. Set any variable yourself to override the default slot; each must be an absolute path, and a relative value fails loudly rather than silently falling back to the real root. `FLEET_CONSOLE_DIR` remains accepted as the former name of `FLEET_CONSOLE_DATA_DIR` so already-shipped Desktop shells keep working, but Desktop honors that older name only when packaged.

Because a caller's own values win, an agent session that a Console launched already carries that Console's `FLEET_DATA_DIR`, `FLEET_CONSOLE_DATA_DIR`, and `FLEET_DESKTOP_DATA_DIR` — plus pnpm's `INIT_CWD`, which the `fleet` launcher uses as its working directory. From such a session, `pnpm console start` in a worktree reports or reuses the parent's running Console instead of starting the worktree's, and a launcher run starts in the main checkout. Before starting anything, set the worktree's own absolute slot paths explicitly and clear `INIT_CWD`, then confirm the served lock and process path belong to the worktree.
