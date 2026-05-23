---
id: "prd-infra-agent-executor-migration-source"
created: "2026-05-23T05:39:14.652Z"
sourceType: "inline"
title: "PRD: Agent Executor 엔진의 인프라 계층 이전"
tags: ["fleet-core", "fleet-infra", "agent-executor", "package-migration", "architecture", "dependency-injection"]
contentHash: "6de036c4"
---
Nimitz Task Force 3-backend(Claude, Codex, Cursor) 합의 결과. executor 엔진은 도메인 로직이 아닌 런타임 인프라이며, fleet-infra의 기존 도메인(job/auth/log/settings)과 동일 계층에 속한다. 5개 역방향 의존성은 2-method ExecutorPort(boot-time DI) + co-migration(external-mcp.ts) + 직접 import(invoke→fleet-mcp-server)으로 해소. TrackStatus 타입은 fleet-infra로 SSoT 이전. bootstrap.ts와 tools.ts는 fleet-core에 잔류. 소비자(fleet-agent) import 경로 변경 0건.