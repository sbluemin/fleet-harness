---
name: assumption-audit
description: Resolve decision-shaped Context Confidence gate failures one blocking gap at a time before the active protocol re-applies its planning boundary.
---

Use this auxiliary skill only when the active protocol or Context Confidence re-entry path has already found an unresolved blocking gap and the gap is decision-shaped. This skill is not a protocol mode, does not replace the active protocol, and cannot declare the planning boundary passed by itself.

For each unresolved blocking gap, triage the gap before questioning:

- **Scout-shaped**: the answer should come from direct file reads, focused reconnaissance, carrier scouting, or another verifiable evidence source. Send the workflow back to that evidence-gathering path instead of asking the user to decide.
- **Decision-shaped**: the answer depends on preference, scope, risk appetite, product intent, or authority that evidence alone cannot settle. Ask exactly one question for this gap.
- **Escalation-shaped**: the answer requires authority beyond the current operator, changes the mission boundary, repeatedly fails to resolve, or would weaken the active protocol's required gate. Escalate to the Admiral of the Navy (대원수).

When a gap is decision-shaped, ask one question at a time. Present your recommended answer first, then give one or two concrete alternatives when useful. Walk decision dependencies one branch at a time until the current gap is resolved; do not bundle unrelated gaps into the same question.

After the gap is answered, report the resolved decision in one short line and return control to the active protocol or Context Confidence Standing Order. The active workflow must re-evaluate confidence and re-apply the required planning boundary gate before planning proceeds.
