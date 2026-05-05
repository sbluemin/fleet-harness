---
id: "fleet-wiki-user-operations-source"
created: "2026-05-05T10:06:14.804Z"
sourceType: "inline"
title: "docs/fleet-wiki-reference.md (Part 1 사용자 관점 + 부록 C)"
tags: ["fleet-wiki", "operations", "admiral-view", "current"]
contentHash: "a7828852"
---
[원본 문서 docs/fleet-wiki-reference.md 의 Part 1 — 대원수(사용자) 관점 + 부록 C 디렉터리 레이아웃을 통합한 reference. 워크스페이스 부트스트랩, schema 사용자화, web UI 운영, conflict 해결, git 관리, 백업/복구, 트러블슈팅 5종을 포함한다. 본 entry 의 raw source 는 docs 원본 전체 markdown 이며, body 는 schema 의 body 섹션 컨벤션에 맞게 합성된 압축 버전이다.]

원본 문서 내용 — 후속 entry (fleet-wiki-ai-usage, fleet-wiki-drydock-codes) 와 동일한 source content 로 dedupe 됨.

## Part 1 — 대원수(사용자) 관점 핵심
- 워크스페이스 부트스트랩: ensureMemoryRoot + ensureWorkspaceSchema 가 첫 도구 호출 시 자동 생성
- schema 사용자화: schema/wiki-schema.md 편집으로 LLM 행동을 워크스페이스별로 길들임
- 일상 운영: fleet-wiki CLI 로 detached 로컬 SPA, 8개 routes
- 패치 승인: web /queue 에서 individual approve 또는 approve_set
- conflict 해결: conflicts/{id}/ diff 검토 후 사용자 판단
- git 관리: .fleet/knowledge/** 만 tracked, 나머지 .fleet/* ignored
- 트러블슈팅: 500 internal_error / not_found / log 누적 / schema 편집 손실 등 5종

## 부록 C — 디렉터리 레이아웃
.fleet/knowledge/ 의 wiki/raw/schema/queue/archive/conflicts/index.json/log.md 트리 구조 전체.