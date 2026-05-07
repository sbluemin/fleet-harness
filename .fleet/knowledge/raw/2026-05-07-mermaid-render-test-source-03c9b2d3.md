---
id: "mermaid-render-test-source"
created: "2026-05-07T13:30:21.403Z"
sourceType: "inline"
title: "mermaid-render-test.md"
tags: ["test", "visual-regression", "mermaid", "diagram"]
contentHash: "03c9b2d3"
---
> Mermaid 렌더 회귀 테스트 — 원본 노트
>
> Maritime Codex 시각 doctrine과 strict CSP 환경에서 Mermaid v11 통합의 시각적/기능적 회귀를 점검하기 위한 위키 entry. 7개 다이어그램 타입(flowchart, sequence, class, state, ER, pie + 의도적 파싱 실패)과 일반 코드 블록을 한 문서에 섞어, 다음을 검증한다:
>
> 1. `.diagram-block` Component Identity Anchor 시각 사양 (brass→aurora hairline, MANIFEST · DIAGRAM eyebrow, brass 노드 보더, aurora-deep 엣지)
> 2. 한글 라벨 렌더링 (htmlLabels: false 환경에서 회귀)
> 3. error state 격리 (의도 실패 블록이 다른 다이어그램/본문에 영향 X)
> 4. 코드블록 vs 다이어그램블록 시각 분리
> 5. 모바일 폭 overflow 방지
> 6. pending → rendered 전환 시각 신호
>
> Admiral이 직접 브라우저에서 `/entry/mermaid-render-test`로 접근해 각 항목을 육안 확인한다.