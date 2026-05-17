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
| **Fleet PTY** | Lower | `CarrierRosterLine` + `EditorSection` + `JobsLine` | The Fleet control area below the Dedicated CLI PTY. This region manages the Fleet orchestration interface, input editor, carrier roster, and job/status controls. |

### Fleet PTY Sub-regions

The **Fleet PTY** is further divided into the following functional areas:

- **Carrier Roster**: The status strip displaying active carriers (e.g., Nimitz, Sentinel).
- **Fleet Action Protocol Editor**: The `EditorSection` input area for sending directives to the Fleet. It owns the Fleet Action Protocol border, prompt line, and status border.
- **Status/Jobs Controls**: The `JobsLine` area below the editor, plus any Fleet status details integrated into the editor status border.

## Interpretation of Requests

When a request uses the canonical terms above, it should be interpreted as follows:

- **"Update the Dedicated CLI PTY..."**: Focus on `PtyHost`, `PtyView`, child CLI process lifecycle, raw terminal rendering, ANSI handling, PTY sizing, or keyboard forwarding into the embedded CLI.
- **"Modify the Fleet PTY..."**: Target `CarrierRosterLine`, `EditorSection`, `JobsLine`, Fleet input behavior, carrier roster badges, Fleet Action Protocol editor rendering, status/job lines, or lower-section layout.
- **"Bridge input between PTYs"**: Refers to logic that routes or duplicates keystrokes/commands between the embedded CLI and the Fleet orchestration layer.

## Operational Standards

- **ESM-Only**: This package targets `NodeNext` and must remain pure ESM.
- **Security**: As a PoC, it assumes a trusted environment. Do not introduce sanitization logic that breaks raw ANSI flow unless specifically requested for a "Safe Mode" feature.
- **Environment**: `process.env` is forwarded by default to the child PTY to ensure seamless tool/config parity with the host shell.
