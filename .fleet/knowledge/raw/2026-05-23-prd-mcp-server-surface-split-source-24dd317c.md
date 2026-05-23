---
id: "prd-mcp-server-surface-split-source"
created: "2026-05-23T13:28:59.405Z"
sourceType: "inline"
title: "PRD: Fleet 낭부 MCP 서버 표면 분리 — fleet-carriers와 fleet-wiki 독립 서버화"
tags: ["fleet-mcp-server", "fleet-agent", "fleet-infra", "mcp", "architecture", "shipped"]
contentHash: "24dd317c"
---
Fleet 낭부 MCP 서버 표면 분리 결정의 원시 증거:

1. CHANGELOG.md: "Split Fleet internal MCP access into independent `fleet-carriers` and `fleet-wiki` servers with isolated tokens."

2. 이전 상태: 단일 "fleet-tools" 서버가 모든 Fleet 낭부 도구를 노출. RESERVED_EXTERNAL_MCP_SERVER_IDS에 "fleet-tools"가 포함되어 있어, 이 이름은 이제 외부 사용이 금지된 예약어로 남아 있음.

3. 현재 상태: fleet-agent 런타임은 두 개의 독립적인 MCP 서버 번들을 생성 — 하나는 캐리어 오케스트레이션 도구용, 하나는 위키 지식 도구용. 각 번들은 자체 레지스트리, 서버, 스냅숏 저장소를 가짐.

4. 도구 분리:
   - 캐리어 서버: carrier_dispatch, carrier_jobs
   - 위키 서버: wiki_briefing, wiki_drydock, wiki_ingest, wiki_orient, wiki_patch_edit, wiki_patch_queue, wiki_compile_source, wiki_query, wiki_read, wiki_resolve

5. 테스트 증거: dedicated CLI MCP 등록 테스트에서 carrier 서버의 tools/list는 carrier 도구만, wiki 서버의 tools/list는 wiki 도구만 반환함을 검증. 두 서버의 토큰이 서로 다름을 검증.

6. 전용 CLI 주입: Claude와 Codex 전용 CLI 빌더가 각각 fleet-carriers와 fleet-wiki를 별도의 MCP 서버 항목으로 주입. Codex의 경우 이전 단일 서버 이름 "fleet-tools"가 더 이상 설정에 나타나지 않음을 테스트로 검증.

7. ExecutorPort 인터페이스: getExecutorMcpTools가 serverName 파라미터를 받아 서버별 도구 스코핑을 지원. getExecutorMcpRouterRuntimes가 두 개의 런타임을 각각 이름과 함께 반환.

8. 시스템 프롬프트: fleet-agent의 시스템 프롬프트 빌더가 두 레지스트리의 도구를 모두 수집하여 doctrine 태그로 노출하지만, 각 도구는 원래 소속 서버에 관계없이 동일한 실행 계약을 유지.

9. Fleet Wiki 도구의 범위 정책: 4종 읽기 도구(briefing, orient, read, resolve)는 모든 캐리어에 글로벌 공개, 4종 쓰기/스테이지 도구(drydock, ingest, patch_edit, compile_source, query)는 chronicle 캐리어로 제한, patch_queue는 실행기에서 완전 배제. 이 범위 정책은 위키 서버의 레지스트리에서 처리되며 캐리어 서버와 독립.

10. 구조적 맥락: 이 분리는 fleet-core 해체, fleet-infra 추출, Composition Root 확립이라는 상위 아키텍처 재편의 일환으로 이루어짐. 단일 서버는 초기 프로토타입 시절 소규모 도구 집합에 적합했으나, 캐리어와 위키 도메인이 각각 독립적인 생태계로 성장하면서 서버 수준 분리가 필수가 됨.