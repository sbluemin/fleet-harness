# Fleet Wiki Workspace Schema

Fleet Wiki is a workspace-local PRD (Product Requirements Document) knowledge base. Each entry serves as a PRD for a single feature area, providing refined knowledge synthesized from raw sources.

## Canonical Link Syntax

- Use the `[[wiki:entry-id]]` syntax for links between wiki entries.
- `entry-id` must be lowercase, stable, and filename-safe.

## Entry Frontmatter

Every wiki entry must include frontmatter in YAML format.

### Required Keys
- `id`: Unique ID matching the filename (excluding extension).
- `title`: Human-readable document title.
- `tags`: List of lowercase tags.
- `feature_area`: Feature area (e.g., `harness/btw`, `wiki/core`).
- `lifecycle`: Document status (`proposed` | `shipped` | `frozen` | `deprecated`).
- `created`: ISO timestamp of initial creation.
- `updated`: ISO timestamp of the latest approved content update.
- `version`: Positive integer version number.

### Optional Keys
- `summary`: A single-line summary of the document.
- `supersedes`: Previous wiki ID (or list) replaced by this document.
- `supersededBy`: New wiki ID that replaces this document.

### Deprecated Keys (Prohibited)
- `rawSourceRef`, `status`, `kind`

## Body Sections (Required Order)

The body must strictly follow the order of these 9 sections:

1. `## Overview`: General explanation of the feature's background and necessity.
2. `## Problem`: Specific problem or user pain points to be addressed.
3. `## Goals`: Objectives to be achieved through the feature implementation.
4. `## Non-Goals`: Items explicitly excluded from the current scope.
5. `## User Stories`: User scenarios using the format: `As a <role>, when <situation>, then <behavior/result>`.
6. `## Functional Requirements`: Detailed functional specifications required.
7. `## Acceptance Criteria`: Concrete criteria for determining feature completion.
8. `## Open Questions`: Undecided matters or items requiring further investigation.
9. `## Related`: Related wiki entries or external reference links.

## Prohibited Content

Fleet Wiki focuses on product requirements, not the physical implementation of code. The following content is strictly prohibited from being cited in the body:

- Do not cite code symbols such as file paths, line numbers, function names, or variable names.
- Do not cite Diff content or commit SHAs.
- Do not include time-series change logs or history sections (history is delegated to `updated`/`version` and Git logs).
- Do not describe specific implementation methods or technical implementation rationale.
- **Exception**: Code blocks are allowed only for UI elements directly exposed to users (e.g., key guides, ASCII UI previews, or CLI output examples).

## Filename Convention

All PRD wiki files must follow this naming convention:
- `prd-<feature_area_slug>-<short-title>.md`
- Example: `prd-harness-btw-scroll-dropdown.md`

## Raw Source and Provenance Rules

- Files in the `raw/` directory are immutable evidence.
- Wiki entries must not copy raw sources verbatim; they must be meaningfully synthesized into the PRD format.

## Ingest, Patch, and Lint Workflow

- The existing workflow using 9 tools (ingest, patch, etc.) remains unchanged.
- `wiki_drydock` serves as the lint gate for verifying PRD format compliance and checking for prohibited content. (Strengthening PRD-specific linting is handled in a separate cycle.)
