---
id: "mermaid-render-test"
title: "Mermaid 렌더 회귀 테스트"
tags: ["test", "visual-regression", "mermaid", "diagram"]
created: "2026-05-07T13:30:21.403Z"
updated: "2026-05-07T13:30:21.403Z"
version: 1
rawSourceRef: "raw/2026-05-07-mermaid-render-test-source-03c9b2d3.md"
---
# Mermaid 렌더 회귀 테스트

이 문서는 fleet-wiki-web의 Mermaid v11 통합이 Maritime Codex 시각 doctrine과 보안 invariant를 모두 만족하는지 시각적으로 확인하기 위한 회귀 테스트 entry이다.

## 1. Flowchart — 한글 라벨

```mermaid
flowchart TD
    A[원본 마크다운] --> B{```mermaid 분기}
    B -->|예| C[Placeholder emit]
    B -->|아니오| D[highlight.js 경로]
    C --> E[MutationObserver 감지]
    E --> F[dynamic import mermaid]
    F --> G[strict 렌더]
    G --> H[격리 DOMPurify sanitize]
    H --> I[SPA href 후처리 치환]
    I --> J[.diagram-block swap]
```

## 2. Sequence Diagram — 한글 라벨

```mermaid
sequenceDiagram
    actor 대원수
    participant 제독 as Admiral
    participant 함장 as Carrier
    대원수->>제독: 명령 하달
    제독->>함장: 임무 디스패치
    함장-->>제독: 결과 보고
    제독-->>대원수: 종합 보고
    Note over 제독,함장: 비동기 실행
```

## 3. Class Diagram

```mermaid
classDiagram
    class Carrier {
        +String id
        +String captain
        +dispatch(request)
        +finalize()
    }
    class Genesis {
        +execute(plan)
    }
    class Sentinel {
        +review(target)
    }
    Carrier <|-- Genesis
    Carrier <|-- Sentinel
```

## 4. State Diagram — 다이어그램 hydration 라이프사이클

```mermaid
stateDiagram-v2
    [*] --> pending: placeholder emit
    pending --> rendered: sanitize 통과
    pending --> error: parse 실패
    rendered --> [*]
    error --> [*]
```

## 5. ER Diagram

```mermaid
erDiagram
    WIKI-ENTRY ||--o{ RAW-SOURCE : "원본 보관"
    WIKI-ENTRY ||--o{ PATCH : "이력 추적"
    PATCH ||--|| QUEUE-ITEM : "대기"
```

## 6. Pie Chart — 한글 라벨

```mermaid
pie title 정찰 시간 분포
    "코드 탐색" : 45
    "외부 조사" : 25
    "Doctrine 검토" : 15
    "결정 합의" : 15
```

## 7. 일반 코드 블록 (회귀 비교용)

다이어그램 블록과 코드 블록의 시각 분리(eyebrow / 툴바 / 색상)가 확실히 구분되는지 비교한다.

```typescript
export function installDiagramHydrator(root: ParentNode): void {
  const observer = new MutationObserver(scan);
  observer.observe(root, { childList: true, subtree: true });
  scan();
}
```

## 8. 인접 컨텍스트

본문 텍스트와 다이어그램이 같은 [[wiki:mermaid-render-test]] 문서 안에서 자연스럽게 섞이는지(스태거 reveal 애니메이션이 다이어그램 hydrate와 충돌하지 않는지) 확인한다. 모바일 폭에서도 다이어그램이 컬럼을 넘치지 않아야 한다.

## 9. 의도적 파싱 실패 (error state 격리 확인)

```mermaid
flowchart TD
    이것은 -- 잘못된 -> 문법
    --
```

위 블록이 `.diagram-block`의 error 상태로 격리되어 표시되며, 이 문서의 다른 다이어그램과 본문 paint에는 영향을 주지 않아야 한다.

## 10. 검증 항목 (수동 시각 QA)

- 각 `.diagram-block` 상단에 brass→aurora 1px hairline 존재
- eyebrow 라벨 `MANIFEST · DIAGRAM`이 JetBrains Mono 대문자로 표시
- 노드 보더는 brass, 엣지는 aurora-deep 톤
- 한글 라벨이 깨지거나 포커스 잃지 않음
- 모바일 폭에서 SVG가 컬럼 밖으로 넘치지 않음
- error state의 `--coral` 색상 적용
- 일반 코드 블록은 macOS 점 + "복사" 버튼 그대로
- pending 상태의 시각적 신호(스피너 등) 1초 이내 rendered로 전환