---
name: wiki-history
description: Preserve the rationale of an already-approved decision and its prior cognitive debt as Fleet Wiki PRD history. Not for future plans, implementation guides, or general documentation.
---

# Wiki History

Preserve **why an already-made decision was made** when code/git history cannot explain it. Deliver a reviewable Wiki patch; permanent registration requires explicit approval.

## Inputs and evidence

Resolve `<feature-or-decision-topic>` and raw decision evidence from the request/existing records. Separate prior friction, structural cause, debate/constraints/trade-offs, and user-perceived effects. Never present an undecided question as approved history. Ask only for missing decision evidence.

## Procedure

1. Call `wiki_orient` for current PRD structure, tags, and naming. Find same-area records: update a duplicate; retain adjacent entries as `related` candidates.
2. Before writing, read [Format and exclusions](references/format.md). The host authors the eight sections directly: Overview, Problem, Goals, Non-Goals, User Stories, Functional Requirements, Acceptance Criteria, Related. Include only WHY and user-facing contracts.
3. Check current Wiki tool schemas, then stage create/update through `wiki_ingest`. Use `prd-<area>-<topic>` and put raw decision evidence in `source`. Read the actual preview through `wiki_patch_queue(action:"show")` and present it to the user.
4. Verify every statement below is true. Correct violations through `wiki_patch_edit` or re-staging, then inspect the new preview.
   - The body has no source paths, symbols, line numbers, code, build commands, or dependency graphs.
   - It has no future plans, TODOs, roadmaps, or implementation-action sentences.
   - It does not duplicate patch-envelope metadata in body YAML.
   - It uses exactly the required sections, with a structural cause in Problem.
   - User Stories and Acceptance Criteria describe actual user experience and directly verifiable conditions.
   - Related links are evidence-backed, and the decision rationale is understandable in isolation.
5. Register with `wiki_patch_queue(action:"approve")` **only after explicit user approval of that preview**. Do not reuse approval if revisions change its meaning.

## Completion and blocks

Without approval, deliver patch id/preview for review and stop. After approval, confirm registration from the tool result and report entry id/outcome. Never replace unavailable tools/schemas or missing evidence with claimed success. General model-prompting advice does not relax Wiki formatting rules.
