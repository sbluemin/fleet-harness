---
id: "guide-003-fleet-wiki-source"
created: "2026-05-07T15:45:43.577Z"
sourceType: "inline"
title: "fleet-wiki 사용법 가이드 원본"
tags: ["guide", "fleet-wiki", "workflow", "onboarding", "current"]
contentHash: "e1eb2856"
---
# fleet-wiki 사용법 가이드 원본

## 개요

fleet-wiki는 워크스페이스 로컬 마크다운 지식 베이스다.
모든 쓰기 작업은 패치 큐를 통해 인간이 승인해야 반영된다.

## 5단계 워크플로우

1. 캡처: PI 세션에서 위키 패치 생성 (fleet:wiki:menu → 세션 캡처)
2. 스테이징: wiki_ingest 또는 wiki_compile_source로 패치 큐 등록
3. 검토: wiki_patch_queue list/show 또는 웹 UI 조회
4. 승인/반려: wiki_patch_queue approve/reject 또는 웹 UI
5. 조회: wiki_orient, wiki_briefing, wiki_read, wiki_resolve, wiki_query

## 9개 MCP 도구

- wiki_orient: 워크스페이스 현황 스냅샷
- wiki_briefing: 키워드/태그/ID 검색
- wiki_read: 전문 읽기 (full/summary/facts/diffable 모드)
- wiki_resolve: 컨텍스트 팩 합성
- wiki_query: 인용 기반 질의 및 답변 스테이징
- wiki_ingest: 단일 패치 스테이징
- wiki_compile_source: 배치 멀티 페이지 인제스트
- wiki_patch_queue: 큐 list/show/approve/reject/approve_set
- wiki_drydock: 정합성 lint 게이트

## fleet-wiki-web

fleet-wiki 명령어로 로컬 웹 UI(127.0.0.1:3737) 실행.
/queue, /entry/:id, /conflicts, /log 등 SPA 라우트 제공.
