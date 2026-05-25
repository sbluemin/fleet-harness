---
template_id: prd
description: Product requirements document. 
title: Title MUST follow the "PRD: {feature summary}" format.
---
# PRD Template

<!--
COMPOSER GUIDANCE (carriers must read before authoring):

1. TITLE FORMAT
   The entry title MUST follow the "PRD: {feature summary}" pattern.
   Example: "PRD: fleet-cli CLI argument 인터랙티브 메뉴 전환".
   The "PRD: " prefix is mandatory; the trailing summary should be a concise
   noun phrase describing the feature area or decision scope.

2. NO DUPLICATE FRONTMATTER IN BODY
   Do NOT include a YAML frontmatter block (e.g., "---\nid: ...\n---") at the
   start of the body. Frontmatter fields (id, title, tags, created, updated,
   version, template_id) are supplied separately via wiki_ingest parameters
   and the entry envelope. A duplicate "---" block inside the body will be
   stored verbatim and render as literal text in the wiki entry.

3. BODY START
   The body MUST start directly with the first level-2 heading ("## Overview").
   The level-2 headings below are deterministic body sections enforced by
   wiki_drydock — preserve their order and naming. Do not add, rename, or
   reorder them; additional level-3 subsections inside each section are fine.
-->

## Overview

## Problem

## Goals

## Non-Goals

## User Stories

## Functional Requirements

## Acceptance Criteria

## Open Questions

## Related
