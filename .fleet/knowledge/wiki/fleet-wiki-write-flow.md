---
id: "fleet-wiki-write-flow"
title: "Fleet Wiki Write Flow (ingest, patch_queue, compile_source)"
tags: ["fleet-wiki", "write-flow", "approval-gate", "current"]
created: "2026-05-05T09:59:12.767Z"
updated: "2026-05-05T09:59:12.767Z"
version: 1
rawSourceRef: "raw/2026-05-05-fleet-wiki-write-flow-source-fa2105a8.md"
---
## Summary

Write flow 는 모든 wiki mutation 을 human approval gate 로 강제한다. LLM 은 patch 를 stage 만 하고, 사용자 승인 후 wiki/ 에 진입.

## Facts

- wiki_ingest: 단일 entry 의 raw source + body 를 patch 로 stage. mode=auto / create / update.
- wiki_compile_source: 한 source 가 여러 wiki page 를 동시 갱신할 때 사용. mode=preview 는 mutation 없음, mode=stage 는 patch_set 으로 묶어 enqueue.
- wiki_patch_queue: action=list / show / approve / reject / approve_set.
- conflict 발생 시 .fleet/knowledge/conflicts/ 에 evidence 보존. drydock 의 unresolved_conflict warning 으로 가시화.
- patch ID 는 timestamp + summary + target + body 의 SHA-256 hash 로 충돌 방지.

## Decisions

- LLM 은 conflict 자동 resolve 시도 금지 — 사용자 영역.
- create_wiki overwrite 는 validatePatch 단계에서 거부 (web 은 409 create_target_exists).
- raw source 는 immutable. 같은 content 는 dedupe, 다른 content 는 별개 파일 보존.

## Evidence

- 코드: packages/fleet-wiki/src/{patch,patch-set,conflicts}.ts, packages/fleet-wiki/src/tools/{ingest,patch-queue,compile-source}.ts
- 운영 가이드: docs/fleet-wiki-reference.md Part 2.4 새 지식 캡처 / Part 2.5 다중 페이지 컴파일

## Related

- [[wiki:fleet-wiki-9-tools]]
- [[wiki:fleet-wiki-read-flow]]