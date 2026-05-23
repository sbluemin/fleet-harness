---
name: wiki-history
description: Register a Fleet Wiki PRD entry that captures cognitive-debt-resolving decision history. NOT a code-grounded document. NOT a planning document. Records the WHY of a decision so future readers do not have to reverse-engineer it from code and git log.
---

# Wiki History Authoring

Use this skill when authoring a Fleet Wiki history PRD that enshrines the motivation behind a decision that has already been made.

## Inputs

Replace each `<placeholder>` before running.

- `<feature-or-decision-topic>` — The feature, decision, or change whose *why* needs to be preserved (required).

## Sole Purpose — Cognitive Debt Resolution

This document exists for exactly one reason: to let future-self and future-team understand **why this decision was made** without having to reverse-engineer it from code and git log.

- Code and git log accurately show *what* changed, but the *why* evaporates over time.
- The wiki preserves that *why* permanently, so future readers never need to reconstruct the decision context.
- This wiki is **NOT a planning document**. It does not describe future work. It enshrines the motivation behind a decision that has already been made.
- This wiki is **NOT an implementation guide**. Code and PRs already explain how it was built.

## Hard Rules

### DO — must be present

- The cognitive debt / friction / risk that existed in the **previous state**
- The **structural cause** of that cognitive debt (root cause, not just the symptom)
- The **decision context** (debates, agreements, constraints, trade-offs) under which the change was approved
- The **effect users/teams now feel** (lower learning cost, eliminated collision risk, restored consistency, etc.)
- `related` links (`[[wiki:<id>]]`) to existing entries in the same feature area

### DO NOT — must be absent

- Source file paths, function names, line numbers, class names, variable names
- Code snippets or pseudo-code
- Planning phrases such as "next step", "TODO", "Roadmap", "Phase 2", "future work"
- Implementation actions such as "changed X to Y", "added to module Z", "refactored A into B"
- "Here is how to implement it" style implementation guidance
- Build/test commands, directory trees, package dependency graphs

## Output Format

Follow the same section structure used by existing Fleet Wiki PRD entries (`prd-*`):

1. **Overview** — 1–2 paragraphs stating what was decided. No source locations.
2. **Problem** — Cognitive debt / friction / risk in the previous state. Include the structural cause, not just the symptom.
3. **Goals** — Targets this decision resolves, framed from the user's perspective.
4. **Non-Goals** — Areas intentionally left unchanged. Prevents scope misreading.
5. **User Stories** — "As a … when … then …" form, describing felt experience.
6. **Functional Requirements** — Only the **call surface / UX / contract** the user actually faces. Internal implementation changes are forbidden here.
7. **Acceptance Criteria** — A checklist verifiable by the user directly. UX checks, not unit-test assertions.
8. **Related** — Links to adjacent entries in the same/neighboring feature area.

Every section must be written from "**why**" and "**what the user feels at the surface**". If a single line slips into "how it was implemented", rewrite it.

## Required Workflow

1. Call `wiki_orient` to capture existing PRD section structure, tag vocabulary, and naming patterns.
2. Identify existing entries in the same feature area (e.g., `coding-agent`, `harness`, `carrier`) and reserve them as `related` candidates.
3. Dispatch the **Chronicle carrier** via `carrier_dispatch`:
   - `<doc_type>`: `wiki-create` (new) or `wiki-update` (refine existing)
   - `<target>`: proposed entry id, format `prd-<area>-<topic>`
   - `<audience>`: `contributors`
   - `<scope>`: **Quote the DO / DO NOT rules from this skill verbatim into the request.** Chronicle is also an LLM; without explicit guardrails the output drifts into code-grounded or planning-style writing.
4. After Chronicle enqueues a patch with `wiki_ingest`, fetch the preview using `wiki_patch_queue(action:"show")` and present it to the Admiral of the Navy.
5. Walk through the preview line by line, checking each DO / DO NOT rule. If any rule is violated (code detail, planning phrasing, implementation action), reject and re-dispatch Chronicle with a specific correction note.
6. Only after explicit Admiral-of-the-Navy approval, register the entry via `wiki_patch_queue(action:"approve")`. **Never auto-approve** — wiki entries are permanent.

## Pre-Registration Self-Check

Before approving the patch, ask each question once more:

- [ ] Does any source file path, function name, or line number appear in the body?
- [ ] Do phrases like "next step", "later", "future", "TODO", or "Roadmap" appear?
- [ ] Are there implementation-action sentences ("changed X to Y", "added Z")?
- [ ] Does the Problem section describe the **structural cause**, not just the visible symptom?
- [ ] Are the User Stories written from the actual user/carrier perspective, not the developer's?
- [ ] Can a reader, one year from now, understand "why this decision was made" from this document alone?

If any answer is NO, do not register — rewrite first.
