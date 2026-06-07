# Protocols Doctrine

`packages/fleet-admiral/src/protocols/` owns the Admiral prompt protocol policy. fleet-harness ships exactly **one** operating protocol — the Fleet Action Protocol — and it is immutable: there is no catalog, no registry, no switching API, and no settings key for selecting a protocol. The protocol body is hard-wired into the system prompt at build time. Any new injectable composition must use explicit `create*(deps): Interface` pure factories and must not introduce DI containers or frameworks.

## Standing Orders

Standing Orders are cross-cutting mechanisms always injected into the system prompt, regardless of caller or session. They are protocol-agnostic and complement the Fleet Action Protocol's phase workflow.

- **Mission Anchor**: Anchors every phase decision to the Mission Objective; enforces pre-phase recall, post-phase self-check, and drift recovery.
- **Context Confidence**: Owns the evidence-sufficiency gate (complete / sufficient / partial / speculative) invoked at Fleet Action's Phase 3 entry. Defines the operational levels, evidence-checklist requirement, gate-failure re-entry, and re-evaluation triggers.
- **Carrier Operations Policy**: Defines how and when the host agent delegates tasks to carriers.
- **Deep Dive**: Strategy for recursive investigation and root-cause analysis.
- **Result Integrity**: Governs how carrier results are evaluated, cross-carrier feedback loops, and retry policy on carrier failures.

## Fleet Action Protocol

The Fleet Action Protocol body lives as the `FLEET_ACTION_PROMPT` constant in `fleet-action.ts`. During system prompt synthesis it is inlined directly inside the `<fleet section="protocol">` block — there is no protocol-name wrapper heading beyond the composer-injected `# Fleet Action Protocol — Operational Doctrine`, no `## Available Protocols` catalog, and no per-protocol metadata block. The protocol defines a 7-phase workflow plus a Completion Report contract; its headings are rendered at `###` depth so they remain children of that composer heading.

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
  + [Always] <fleet section="protocol">                       ← Fleet Action Protocol body, inlined
  + [Always] <fleet section="standing-orders" type="<id>">    ← one block per Standing Order
```

Tool-specific usage and argument details remain live MCP metadata exposed through tool descriptions and schemas, not static prompt sections.

## HUD Integration

The Fleet Action Protocol does not export a HUD display label. Fleet CLI owns its lower-pane status rendering independently from the prompt protocol body.
