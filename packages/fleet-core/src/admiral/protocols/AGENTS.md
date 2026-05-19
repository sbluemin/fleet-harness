# Protocols Doctrine

`packages/fleet-core/src/admiral/protocols/` owns the modular prompt policy system that governs how the host agent (PI) operates, composed of **Standing Orders** and **Protocols**.

## Operational Protocols & Standing Orders

The Admiral extension implements a modular prompt policy system that governs how the host agent (PI) operates. This system is composed of **Standing Orders** and **Protocols**.

### Core Concepts

| Concept | Definition | Scope |
|---------|------------|-------|
| **Standing Orders** | Cross-cutting mechanisms always injected into the system prompt. | Global — applies to all sessions and protocols. |
| **Protocols** | Mutually exclusive workflows that define the current operational mode. | Session-specific — exactly one protocol is always active. |

### Standing Orders

- **Carrier Operations Policy**: Defines how and when PI should delegate tasks to carriers.
- **Deep Dive**: Strategy for recursive investigation and root-cause analysis.
- **Always Active**: These are injected into every agent start sequence regardless of the selected protocol.

### Protocols

- **Fleet Action Protocol (Alt+1)**: The default, high-performance workflow for standard operations.
- **Fleet Action Only**: Fleet Action is the only registered protocol. Additional protocols can be introduced later, but no alternate protocol is active today.
- **Switching**: The active protocol is surfaced through protocol state and HUD labels. With the current single-protocol catalog, `Alt+1` restores Fleet Action.

### Prompt Structure

에이전트에게 전달되는 최종 시스템 프롬프트는 다음과 같은 계층 구조로 합성됩니다:

```text
System Prompt
  + [Boot] Initial Slate (pnpm dev 사용 시 FLEET_HARNESS_DEV=1로 인해 RISEN 개발 컨텍스트 활성화, 그 외 빈 문자열)
  + [Always] Standing Orders (Carrier Operations Policy + Deep Dive + ...)
  + [Always] Active Protocol (Fleet Action Protocol, etc.)
```

### UI & UX Integration

- **Editor Border Color**: The editor's border color changes based on the active protocol through the `core-hud/border-bridge` module-level set/get API.
- **Editor Top Border (Center Label)**: The active protocol short label (e.g., `⚓ Fleet Action`) is rendered at the center of the editor's top border via the `core-hud/border-bridge` `setEditorRightLabel` API.
- **Editor Bottom Border (Right Label)**: The current session's operation name is rendered at the right end of the editor's bottom border via the `core-hud/border-bridge` `setEditorBottomRightLabel` API. Distinct domain from protocol UI but shares the editor border surface.
- **Settings Popup (Alt+/)**: The "Admiral" section displays the current protocol state; protocol switching currently resolves to Fleet Action via `Alt+1`.

### Key Bindings

| Key | Protocol / Action |
|-----|-------------------|
| **Alt+1** | Switch to Fleet Action Protocol |
| **Alt+2~9** | Unassigned protocol expansion slots |
| **Alt+/** | Open Settings (to configure Admiral parameters) |
