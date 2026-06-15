---
template_id: freestyle
description: Free-form document with no enforced body sections. Use for structural or reference notes (architecture overviews, package-structure maps, dependency graphs) that do not fit the PRD section schema.
title: Free-form title. No mandatory prefix.
---
# Freestyle Template

<!--
COMPOSER GUIDANCE (carriers must read before authoring):

1. NEAR-FREE-FORM (ONE REQUIRED SECTION)
   This template enforces exactly one required body section ("## Overview").
   Every other heading and the overall structure are chosen freely by the
   author. Use this template only when the PRD section schema does not fit —
   for example architecture and package-structure references, dependency
   graphs, or onboarding overviews. The body must start with "## Overview";
   add any further "##" sections you need afterward.

2. NO DUPLICATE FRONTMATTER IN BODY
   Do NOT include a YAML frontmatter block ("---\nid: ...\n---") at the start
   of the body. Frontmatter fields (id, title, tags, created, updated,
   version, template_id) are supplied separately via wiki_ingest parameters
   and the entry envelope.

3. PERMITTED CONTENT
   This document type explicitly permits architecture and package-structure
   references (package names, layer diagrams, dependency graphs, directory
   layout) and user-facing examples (CLI output, key guides, ASCII previews).
   The workspace prohibitions on implementation-level code symbols (function
   names, line numbers, diffs, commit SHAs) and time-series change logs still
   apply; wiki_drydock reports any such citation as a warning, not a hard
   failure.
-->

## Overview
