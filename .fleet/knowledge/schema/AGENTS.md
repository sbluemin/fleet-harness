# Fleet Wiki Workspace Schema

This directory defines the workspace-local operating conventions for `.fleet/knowledge`.

## Maintainer Role

- Treat `wiki-schema.md` as the primary reference for common Fleet Wiki rules.
- Treat `template-*.md` files as the primary reference for document-type body sections.
- Reject any entry that cites code paths, function names, line numbers, diffs, commit SHAs, or time-series change logs in the body unless the selected template explicitly allows user-facing examples.
- Preserve user edits. Automated setups may create missing default files but must not overwrite existing schema files.

## Scope

- Applies to `.fleet/knowledge/wiki/`, `.fleet/knowledge/raw/`, `.fleet/knowledge/queue/`, `.fleet/knowledge/archive/`, `.fleet/knowledge/conflicts/`, and `.fleet/knowledge/index.json`.
- Oversee compliance with filename conventions such as `prd-<feature_area_slug>-<short-title>.md` and guide-prefixed pages.
- Restrict the use of deprecated keys (`kind`) in frontmatter.
- Treat `rawSourceRef` as current latest-provenance metadata.
- Does not grant authority to bypass the human approval queue.

## Template Policy

- `template-prd.md` and `template-guide.md` are default templates.
- Template frontmatter is guidance only; level-2 headings define deterministic required body sections.
- Existing persisted entry template compliance issues are warnings; ingest and approval remain hard gates.
