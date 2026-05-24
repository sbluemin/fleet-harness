# Fleet Wiki Workspace Schema

Fleet Wiki is a workspace-local knowledge base. Each entry must follow common workspace conventions plus the selected document template.

## Canonical Link Syntax

- Use the `[[wiki:entry-id]]` syntax for links between wiki entries.
- `entry-id` must be lowercase, stable, and filename-safe.

## Entry Frontmatter

Every wiki entry must include frontmatter in YAML format.

### Required Keys
- `id`: Unique ID matching the filename (excluding extension).
- `title`: Human-readable document title.
- `tags`: List of lowercase tags.
- `created`: ISO timestamp of initial creation.
- `updated`: ISO timestamp of the latest approved content update.
- `version`: Positive integer version number.

### Optional Keys
- `template_id`: Optional template identifier matching `schema/template-{id}.md`.
- `summary`: A single-line summary of the document.
- `rawSourceRef`: Latest immutable raw provenance ref written by Fleet Wiki tooling.
- `rawSourceRefs`: Ordered provenance history entries, each with `ref` and optional `title`/`hash`.
- `supersedes`: Previous wiki ID (or list) replaced by this document.
- `supersededBy`: New wiki ID that replaces this document.

### Deprecated Keys (Prohibited)
- `kind`

## Template Files

- Body section requirements live in `schema/template-{id}.md` files.
- Template frontmatter is guidance only and is not deterministically enforced.
- Every level-2 heading (`## Heading`) in the selected template is a required entry body section.
- Validation uses subset semantics: required template sections must exist in the entry body, order is ignored, and extra entry sections are allowed.
- Default templates are `template-prd.md` and `template-guide.md`.

## Prohibited Content

Fleet Wiki focuses on product knowledge, not the physical implementation of code. The following content is prohibited from being cited in the body unless a template explicitly calls for user-facing examples:

- Do not cite code symbols such as file paths, line numbers, function names, or variable names.
- Do not cite Diff content or commit SHAs.
- Do not include time-series change logs or history sections (history is delegated to `updated`/`version` and Git logs).
- Do not describe specific implementation methods or technical implementation rationale.
- **Exception**: Code blocks are allowed only for UI elements directly exposed to users (e.g., key guides, ASCII UI previews, or CLI output examples).

## Filename Convention

PRD wiki files must follow this naming convention:
- `prd-<feature_area_slug>-<short-title>.md`
- Example: `prd-harness-btw-scroll-dropdown.md`

Guide wiki files should use the `guide-` prefix.

## Raw Source and Provenance Rules

- Files in the `raw/` directory are immutable evidence.
- `rawSourceRef` stores the latest raw evidence ref; `rawSourceRefs` preserves deduped provenance history.
- Wiki entries must not copy raw sources verbatim; they must be meaningfully synthesized into the selected template format.

## Ingest, Patch, and Lint Workflow

- The existing workflow uses 10 tools. `wiki_patch_edit` may revise already-pending queue proposals before approval.
- `wiki_ingest` and patch approval enforce selected template body sections as hard gates.
- `wiki_drydock` reports existing persisted template compliance issues as warnings and continues to check prohibited content.
