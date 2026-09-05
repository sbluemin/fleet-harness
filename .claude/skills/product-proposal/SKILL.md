---
name: product-proposal
description: Prepare an undecided Fleet Console feature or improvement direction using live measurements and interactive UX options. Use implementation for approved designs, console-e2e for runtime diagnosis, and design-sweep for recurring design audits.
---

# Product Proposal

Measure the present, separate the user's named solution from their underlying job, and produce a decision-ready UX proposal. Final product-direction selection and implementation are outside this skill.

## Inputs

Record the original request, user-named solution, affected surfaces, and depth (`quick`/`full`). Discover uncertain surfaces; scale small requests to fewer options and narrower measurements. Never send an already-approved direction back through proposal.

## Execution

1. **Freeze the ask:** preserve one verbatim requirement line. Separate named solution from Job-to-be-done; retain explicit constraints/exclusions.
2. **Measure the present:** invoke `console-e2e` on an isolated target build and reproduce the user's actions. That skill and its conditional references own fixtures, boot, and cleanup; do not duplicate path/auth/state-seeding recipes here. Cross-check counts, screenshots, HTTP, and relevant `file:line`. Label unmeasured behavior as hypothesis/unknown, not current fact.
3. **Exercise UX judgment:** treat the named solution as a hypothesis. Choose only fitting prevention, confirmation, undo/recovery, settings, or arming options. Compare each on the same axes: friction, discoverability, accessibility, implementation cost, product consistency, recovery guarantee. Keep product trade-offs visible.
4. **Build the mock:** invoke `frontend-design` using the target Console's current tokens and applicable design doctrine. Report missing external skills rather than vendoring their workflows. Give each option real interactions, strengths/trade-offs/data risk, a recommendation, and phased delivery. Do not copy model-specific prompts or historical token values.
5. **Verify the mock:** exercise it in a separate browser session/new page and inspect screenshots. Match mock labels to the target product's actual UI language; explanation follows session language. Never switch or close the user's tabs.
6. **Deliver:** measured facts → UX judgment → interactive mock URL → recommendation. Follow the environment's publication/file and sensitive-data boundaries. Without an accessible mock, do not claim a complete visual proposal.

## Boundaries and completion

- Do not blur the mock with current product behavior. Label it as a proposal and exclude user data/credentials.
- Check token/interaction-grammar changes against applicable doctrine. Do not silently change product-wide values to solve one panel.
- Once options, evidence, comparison, and recommendation are ready, **stop for the user's direction choice**. Do not begin implementation or PR publication.
- For blocked measurement/mock dependencies, report available investigation and incomplete scope. Never fabricate numbers or browser-verification results.
