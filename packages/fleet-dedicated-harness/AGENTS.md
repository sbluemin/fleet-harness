# Fleet Dedicated Harness Doctrine

`packages/fleet-dedicated-harness` is a specialized Fleet harness PoC designed to embed a dedicated local CLI process (currently Claude CLI, or any `node-pty`-backed process) directly within the Fleet TUI shell.

## Package Identity & Boundary

This package is a **standalone host implementation** for the Fleet TUI. It operates as a high-level assembly point for the engine and the terminal emulator.

- **Must Own**: `PtyHost` adapter, layout composition, TUI mounting logic, and CLI process lifecycle.
- **Must Not Own**: Fleet domain logic (belongs in `fleet-core`), carrier persona definitions (belongs in `fleet-carriers`), or Pi-specific extensions (belongs in `fleet-harness`).
- **Dependencies**: Restricted to `@sbluemin/fleet-tui`, `@sbluemin/fleet-core`, `@sbluemin/fleet-carriers`, `@xterm/headless`, and `node-pty`.

## Canonical Layout Terminology

To ensure consistency across future feature requests and documentation, use these terms to refer to specific UI regions:

| Term | Region | Component/Backing | Description |
| :--- | :--- | :--- | :--- |
| **Dedicated CLI PTY** | Upper | `PtyView` / `PtyHost` / `node-pty` | The primary external terminal area hosting the embedded dedicated CLI process. It currently runs Claude CLI, renders raw ANSI output, and receives direct keyboard input when PTY focus is active. |
| **Fleet PTY** | Lower | `FleetStatusSection` + `CarrierRosterLine` + `JobsLine` | The Fleet control/status area below the Dedicated CLI PTY. It has no visible text input and operates in one of two modes: `MIRROR` (keystrokes forwarded to the upper PTY) or `DEDICATED` (exclusive CLI control). |

### Fleet PTY Sub-regions

The **Fleet PTY** is further divided into the following functional areas:

- **Fleet Status Section**: A single-row separator and centered `Fleet Action Protocol` status line (`FleetStatusSection`). It MUST implement width-safe truncation for small terminal windows.
- **Carrier Roster**: The status strip (`CarrierRosterLine`) displaying active carriers (e.g., Nimitz, Sentinel).
- **Status/Jobs Controls**: The `JobsLine` area displaying detached job count/status.

## Input & Mode Logic

- **Mirroring**: In `MIRROR` mode, the Fleet PTY captures keystrokes and forwards them to the Dedicated CLI PTY.
- **Toggle**: `Ctrl+T` is the canonical key to toggle between `MIRROR` and `DEDICATED` modes.
- **No Visible Input**: The Fleet orchestration layer does not own a dedicated text input area; all interaction flows through the PTY-bridge or detached job controls.

## Interpretation of Requests

When a request uses the canonical terms above, interpret the target scope as follows:

- **"Update the Dedicated CLI PTY..."**: Focus on `PtyHost`, `PtyView`, child CLI process lifecycle, raw terminal rendering, ANSI handling, PTY sizing, and keyboard forwarding into the embedded CLI.
- **"Modify the Fleet PTY..."**: Target `FleetStatusSection`, `CarrierRosterLine`, `JobsLine`, Fleet PTY mode display, carrier roster badges, Fleet Action Protocol status rendering, status/job lines, or lower-section layout.
- **"Bridge input between PTYs"**: Focus on `MIRROR`/`DEDICATED` mode behavior, `Ctrl+T` toggling, and keystroke routing between the lower Fleet PTY and upper Dedicated CLI PTY.

## Development & Execution

- **Root Launcher**: The project provides a root-level `pnpm fleetd` script which **MUST** be used for development. It ensures `@sbluemin/fleet-unified-agent` is built before launching the dedicated harness dev session.
- **Binary Entry**: Installed or linked `fleetd` commands enter through the shebang launcher `bin/fleetd.mjs`, which delegates to the compiled package entrypoint.

## Operational Standards

- **ESM-Only**: This package targets `NodeNext` and must remain pure ESM.
- **Security**: As a PoC, it assumes a trusted environment. Do not introduce sanitization logic that breaks raw ANSI flow unless specifically requested for a "Safe Mode" feature.
- **Environment**: `process.env` is forwarded by default to the child PTY to ensure seamless tool/config parity with the host shell.
