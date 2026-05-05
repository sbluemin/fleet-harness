---
id: "fleet-wiki-9-tools"
title: "Fleet Wiki 9-Tool Suite Overview"
tags: ["fleet-wiki", "tools", "architecture", "current"]
created: "2026-05-05T09:58:48.249Z"
updated: "2026-05-05T09:58:48.249Z"
version: 1
rawSourceRef: "raw/2026-05-05-fleet-wiki-9-tools-source-a2473e9d.md"
---
## Summary

Fleet Wiki 는 9개 MCP 도구를 가진 LLM-maintained markdown knowledge base. 모든 mutation 은 human approval gate 를 거친다.

## Facts

- Read flow tools: wiki_orient, wiki_briefing, wiki_resolve, wiki_read.
- Write flow tools: wiki_ingest, wiki_patch_queue, wiki_compile_source.
- Citation flow tool: wiki_query (mode=answer | stage_answer_page).
- Integrity tool: wiki_drydock with 25+ issue codes covering frontmatter, link, queue, safety, schema, conflict, claim, and semantic checks.
- All LLM-facing output is wrapped in trust boundary tags (curated for entries, untrusted for raw sources).

## Decisions

- Single public subpath `@sbluemin/fleet-wiki` as a leaf package (no fleet-core / pi / anthropic imports).
- Canonical link syntax follows the Canonical Link Syntax section in `.fleet/knowledge/schema/wiki-schema.md`.
- Client SPA inlines link regex instead of importing fleet-wiki to keep the Vite browser bundle clean.
- buildPatchId hashes timestamp + summary + target + body via SHA-256 to prevent compile_source patch_set silent overwrites.
- briefing / query / resolve share a single ranker with token-level OR matching plus exact_phrase priority boost.

## Evidence

- Code: packages/fleet-wiki/src/{tools,boundaries,conflicts,claims,patch-set,search,log,schema,links,briefing}.ts
- Operations guide: docs/fleet-wiki-reference.md
- Tests: fleet-wiki 132/132, fleet-wiki-web 92/92, fleet-harness-extension 100/102 (acp pre-existing unrelated)

## Related

- [[wiki:fleet-wiki-read-flow]]
- [[wiki:fleet-wiki-write-flow]]