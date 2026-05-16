# Fleet Wiki Workspace Schema

This directory defines the workspace-local operating conventions for `.fleet/knowledge`.

## Maintainer Role

- Treat `wiki-schema.md` as the primary reference for the shape, links, provenance, and lint expectations of Fleet Wiki entries.
- **PRD-Centric Management**: All wiki entries are PRDs. Reject any entry that cites code paths, function names, line numbers, diffs, commit SHAs, or time-series change logs in the body.
- Preserve user edits. Automated setups may create missing default files but must not overwrite existing schema files.

## Scope

- Applies to `.fleet/knowledge/wiki/`, `.fleet/knowledge/raw/`, `.fleet/knowledge/queue/`, `.fleet/knowledge/archive/`, `.fleet/knowledge/conflicts/`, and `.fleet/knowledge/index.json`.
- Oversee compliance with the filename convention (`prd-<feature_area_slug>-<short-title>.md`).
- Restrict the use of deprecated keys (`rawSourceRef`, `status`, `kind`) in frontmatter.
- Does not grant authority to bypass the human approval queue.

## Legacy Content Policy

- Existing entries in decision/guide formats are currently **frozen**.
- If a legacy entry needs to be modified, it must be completely rewritten into the new PRD format.
- No bulk migration will be performed.
