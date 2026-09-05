---
name: design-sweep
description: Audit broad or recurring visual inconsistency across Fleet Console and built-in plugins. Use product-proposal for new UX direction and a direct fix for one already-diagnosed CSS defect.
---

# Design Sweep

Audit whether the product reads as one design system. Raw code values are candidates, not findings; confirm against live screens and the current design contract.

## Inputs and scope

Default `<scope>` is core client styles plus all `runtime/fleet-plugins/*` CSS; honor a user-narrowed scope. Default `<depth>` is `full`; `quick` reports static candidates only and never repaints. Consult a prior sweep when available to avoid relitigating approved exceptions.

## Execution

1. Read the scoped current `theme.css`, `instrument-design-contract.test.ts`, applicable `CLAUDE.md`, and adjacent CSS doctrine comments. Actual tokens/contracts/exceptions outrank historical figures in [Detectors and classification](references/detectors.md).
2. Use exact patterns to find raw chromatic colors, decorative signal use, brass-role drift, identity leaks into state/borders, and typography/height/radius candidates. Exclude approved near-achromatic depth effects and other sanctioned exceptions. Investigate real regressions even in test-pinned areas, but do not report their mere existence as defects.
3. For `full`, invoke `console-e2e` on an isolated build and measure affected screens in instrument/maritime/carbon. Confirm static candidates and code-invisible drift through real interactions and screenshots. Mark `quick` results as visually unverified candidates, not confirmed visual defects.
4. Classify confirmed findings as channel inversion / chroma jump / theme invariance / grammar drift. Include `file:line`, screenshot, and a role diagnosis.
5. Route material redesign (new tokens/grammar/identity) through `product-proposal` and its interactive mock. Seek approval of a concrete fix list for existing-contract conformance. Do not repeat approval already granted for that scope.

## After implementation approval

Read [Implementation and verification](references/implementation.md), then make token-first changes in a dedicated worktree. Preserve persisted-key compatibility and co-update contract tests for legitimate grammar changes. Never disable tests or erase exceptions to get green.

Run available tests/typecheck/build for affected Console and each plugin. Before delivery, compare **headed screenshots** against the approved mock in all three themes. Distinguish this mode from `console-e2e`'s default headless and prove the run was headed. If unavailable, leave that gate unverified. Invoke `pr-workflow` only when publication is within authorized delivery scope.

## Completion

A diagnosis request ends after scope, candidates/findings, exceptions, evidence, and recommendation are delivered. An implementation request ends after all approved items, relevant functional checks, and the visual gate pass. Do not keep expanding to unrelated surfaces. Report unmeasured themes, failed checks, exclusions, and publication status separately.
