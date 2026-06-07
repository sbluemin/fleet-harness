# Protocols Doctrine

`packages/fleet-admiral/src/protocols/` owns the Admiral prompt protocol policy. fleet-harness ships an always-on protocol gate that selects one on-demand Fleet protocol skill for operational work: `fleet-protocol-trivial`, `fleet-protocol-standard`, `fleet-protocol-high-risk`, or `fleet-protocol-multi-agent`. Auxiliary operational skills may exist outside the Mode Gate and may be invoked by the active protocol or Standing Orders, but they do not replace the exactly one selected protocol mode. There is no protocol catalog, no registry, no switching API, and no settings key for selecting a protocol. The full protocol bodies are Fleet CLI skill assets, not imports from this package. Any new injectable composition must use explicit `create*(deps): Interface` pure factories and must not introduce DI containers or frameworks.

## Standing Orders

Standing Orders are cross-cutting mechanisms always injected into the system prompt, regardless of caller or session. They are protocol-agnostic and complement the active protocol skill's checkpoint workflow.

- **Mission Anchor**: Anchors every checkpoint decision to the Mission Objective; enforces pre-checkpoint recall, post-checkpoint self-check, and drift recovery.
- **Context Confidence**: Owns the evidence-sufficiency gate (complete / sufficient / partial / speculative) invoked at the active protocol's planning boundary. Defines the operational levels, evidence-checklist requirement, gate-failure re-entry, and re-evaluation triggers.
- **Carrier Operations Policy**: Defines how and when the host agent delegates tasks to carriers.
- **Deep Dive**: Strategy for recursive investigation and root-cause analysis.
- **Result Integrity**: Governs how carrier results are evaluated, cross-carrier feedback loops, and retry policy on carrier failures.

## Protocol Gate and Skills

The static gate lives as `FLEET_PROTOCOL_GATE_PROMPT` in `fleet-action.ts`. During system prompt synthesis it is inlined inside `<fleet section="protocol-gate">` and classifies conversational vs operational intent, then selects exactly one protocol skill mode for operational work. Auxiliary operational skills are outside the Mode Gate list and remain subordinate to the active protocol and Standing Orders. The skill Markdown bodies live under `runtime/fleet-cli/assets/skills/fleet-protocol-*/SKILL.md`; `fleet-admiral` must not import them or depend on `runtime/fleet-cli`.

## Prompt Structure

The final system prompt is composed as:

```text
System Prompt
  + [Boot] Initial Slate (FLEET_HARNESS_DEV=1 activates RISEN dev context, otherwise empty)
  + [Always] <fleet section="preamble">
  + [Always] <fleet section="persona">
  + [Always] <fleet section="role">
  + [Tone-gated] <fleet section="tone">
  + [Always] <fleet section="roster">
  + [Always] <fleet section="protocol-gate">                  ← intent/mode gate for on-demand protocol skills
  + [Always] <fleet section="standing-orders" type="<id>">    ← one block per Standing Order
```

Tool-specific usage and argument details remain live MCP metadata exposed through tool descriptions and schemas, not static prompt sections.

## HUD Integration

The protocol gate does not export a HUD display label. Fleet CLI owns lower-pane status rendering independently from Admiral prompt policy and does not expose a protocol selector UI.
