---
name: wiki-history
description: Preserve the rationale of an already-approved decision and its prior cognitive debt as Fleet Wiki PRD history. Not for future plans, implementation guides, or general documentation.
---

# Wiki History

Preserve **why an already-made decision was made** when code/git history cannot explain it. Wiki writes apply directly to the entry; an overwritten or deleted version stays recoverable through `wiki_edit` history.

## Inputs and evidence

Resolve `<feature-or-decision-topic>` and raw decision evidence from the request/existing records. Separate prior friction, structural cause, debate/constraints/trade-offs, and user-perceived effects. Never present an undecided question as approved history. Ask only for missing decision evidence.

## Procedure

1. Call `wiki_orient` for current PRD structure, tags, and naming. Find same-area records: update a duplicate; retain adjacent entries as `related` candidates.
2. Before writing, read [Format and exclusions](references/format.md), then read the workspace's PRD template (`wiki_schema_read` or `wiki_orient`). The template's level-2 headings are the required sections, in its order; writing refuses an entry that misses one, and `wiki_drydock` reports it. The host authors them directly and includes only WHY and user-facing contracts.
3. Draft the entry and verify every statement below is true before writing.
   - The body has no source paths, symbols, line numbers, code, build commands, or dependency graphs.
   - It has no future plans, TODOs, roadmaps, or implementation-action sentences.
   - It does not duplicate entry frontmatter metadata in body YAML.
   - It uses exactly the template's required sections, with a structural cause in Problem.
   - User Stories and Acceptance Criteria describe actual user experience and directly verifiable conditions.
   - Related links are evidence-backed, and the decision rationale is understandable in isolation.
4. Check current Wiki tool schemas, then write create/update through `wiki_ingest`. Use `prd-<area>-<topic>` and put raw decision evidence in `source`; when updating, pass the `base_version` you read so a concurrent change is refused instead of overwritten.
5. Read the written entry back through `wiki_read`, recheck the list above, and fix any violation through `wiki_edit` (or a new `wiki_ingest` update).

## Completion and blocks

Confirm the write from the tool result and report the entry id, version, and that earlier versions are restorable through `wiki_edit` history. Never replace unavailable tools/schemas or missing evidence with claimed success. General model-prompting advice does not relax Wiki formatting rules.
