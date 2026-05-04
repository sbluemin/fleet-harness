---
id: "build-vs-typecheck-verification-gap-source"
created: "2026-05-04T10:32:27.097Z"
sourceType: "inline"
title: "Session 019df205 — Sentinel discovery of typecheck-only regression after Genesis full cleaning"
tags: ["genesis", "verification", "esbuild", "typecheck", "regression", "instruction-pattern"]
---
Session 019df205-7f41-71ea-8572-cdda97bcdfa1 의 회귀 발견 + 검증 doctrine.

사고: Wave D 전면 클리닝 sortie 후 Genesis 자가 검증 결과 "pnpm -w build 통과 + 169(fleet-core) + 101(pi-fleet-extension) 테스트 통과 + grep 0건" 보고. PASS 같았음.

Sentinel 최종 검증에서 HIGH finding 발견: pi-fleet-extension/src/provider.ts:505 piToolToAgentSpec() 가 새 AgentToolSpec shape 가 아닌 legacy name/label/promptGuidelines shape 로 반환. pnpm -w build 는 통과했지만 pnpm --filter @sbluemin/pi-fleet-extension typecheck 는 실패.

원인: esbuild/tsup 같은 fast bundler 는 type 에러를 stripping 단계에서 놓침. 빌드 통과 ≠ type 정합성. 특히 옵셔널 필드 의존하는 conversion 함수는 undefined return 으로 silently 깨질 위험.

영향: 빌드 통과해도 streamAcp 등록 host extra tools 가 undefined id/name 으로 저장 → MCP 경로에서 사라지거나 충돌.

Sentinel 권고 fix 적용 후 typecheck/build/test 모두 통과.