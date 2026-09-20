---
name: product-proposal
description: Use when the user needs to choose an undecided Fleet Console feature or UX direction; compare measured evidence and interactive options. Use implementation for approved designs, console-e2e for runtime diagnosis, and design-sweep for recurring design audits.
---

# Product Proposal

Measure the present, separate the user's named solution from their underlying job, and produce a decision-ready UX proposal. Final product-direction selection and implementation are outside this skill.

## Inputs

Preserve one verbatim requirement line, distinguish the user-named solution from the underlying Job-to-be-done, and retain explicit constraints/exclusions. Identify affected surfaces and depth (`quick`/`full`); discover uncertain surfaces. `quick` narrows measurements and uses fewer options; neither depth waives uncertainty labels, interaction verification, or Browser handoff. Never send an already-approved direction back through proposal.

## Execution

1. **Measure the present:** invoke `console-e2e` on an isolated target build and reproduce the user's actions. That skill and its conditional references own fixtures, boot, and cleanup; do not duplicate path/auth/state-seeding recipes here. Cross-check counts, screenshots, HTTP, and relevant `file:line`. Label unmeasured behavior as hypothesis/unknown, not current fact.
2. **Exercise UX judgment:** treat the named solution as a hypothesis. Choose only fitting prevention, confirmation, undo/recovery, settings, or arming options. Compare each on the same axes: friction, discoverability, accessibility, implementation cost, product consistency, recovery guarantee. Keep product trade-offs visible.
3. **Build the mock:** invoke `frontend-design` using the target Console's current tokens and applicable design doctrine. Report missing external skills rather than vendoring their workflows. Give each option real interactions, strengths/trade-offs/data risk, a recommendation, and phased delivery. Do not copy model-specific prompts or historical token values.
4. **Verify and hand off:** exercise the proposal's interactions in this Operation's Fleet Browser and inspect screenshots. Match mock labels to the target product's actual UI language; explanation follows session language. Open the final proposal URL in a task-owned tab, confirm the intended page loaded, and select that tab for the user. Do not navigate or close pre-existing user tabs. Leave the proposal tab and any owned serving process needed to view it running for the user's direction choice.
5. **Deliver:** measured facts and labeled hypotheses → UX judgment and trade-offs → interactive proposal URL → recommendation. Follow the environment's publication/file and sensitive-data boundaries. A visual proposal is complete only when the verified proposal is open in Fleet Browser for the user to inspect. If Fleet Browser is unavailable, report the blocker and provide the URL without claiming Browser handoff is complete.

## Boundaries and completion

- Do not blur the mock with current product behavior. Label it as a proposal and exclude user data/credentials.
- Within the authorized proposal scope, continue reversible isolated mock edits and verification without intermediate approval. `console-e2e` owns current-product measurement and cleanup of its verification resources; this skill owns the standalone proposal handoff. Use `console-handoff` when delivering an actual Console instance for the user to try.
- Check token/interaction-grammar changes against applicable doctrine. Do not silently change product-wide values to solve one panel.
- Once options, evidence, comparison, recommendation, and Browser handoff are complete, **stop for the user's direction choice**. Do not begin implementation or PR publication.
- For blocked measurement/mock dependencies, report available investigation and incomplete scope. Never fabricate numbers or browser-verification results.
