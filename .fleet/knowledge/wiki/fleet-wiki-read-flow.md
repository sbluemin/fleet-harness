---
id: "fleet-wiki-read-flow"
title: "Fleet Wiki Read Flow (orient, briefing, resolve, read)"
tags: ["fleet-wiki", "read-flow", "retrieval", "current"]
created: "2026-05-05T09:59:00.098Z"
updated: "2026-05-05T09:59:00.098Z"
version: 1
rawSourceRef: "raw/2026-05-05-fleet-wiki-read-flow-source-8a55c287.md"
---
## Summary

Read flow 는 wiki_orient → wiki_briefing → wiki_resolve → wiki_read 의 4단계 비파괴 검색 흐름이다. 각 단계는 특정 retrieval 시나리오에 최적화되어 있다.

## Facts

- wiki_orient: 단일 호출로 schema/index/log/queue/drydock/trust_boundary 동시 반환. 세션 시작 시 1회 호출.
- wiki_briefing: 키워드 검색. enhanced=false 는 deterministic substring + token OR, enhanced=true 는 alias/tag/freshness/graph boost.
- wiki_resolve: briefing + read 합성. compact_json 또는 markdown_pack 포맷. freshness 필터, claim sidecar 활용.
- wiki_read: ids 명시 정밀 읽기. mode=full / summary / facts / diffable.

## Decisions

- briefing 의 ranker 가 query 와 resolve 에서도 동일 사용 (Wave 15 통합).
- multi-word query 는 token-level OR 매칭. exact_phrase 매칭은 priority boost.
- max_tokens deterministic truncation. 같은 입력 → 같은 출력.

## Evidence

- 코드: packages/fleet-wiki/src/{briefing,search}.ts, packages/fleet-wiki/src/tools/{orient,briefing,read,resolve}.ts
- 운영 가이드: docs/fleet-wiki-reference.md Part 2.3 검색→읽기→합성

## Related

- [[wiki:fleet-wiki-9-tools]]
- [[wiki:fleet-wiki-write-flow]]