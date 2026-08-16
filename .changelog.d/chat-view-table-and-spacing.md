---
branch: chat-view-table-and-spacing
---

### fleet-console

#### Fixed

- Keep the chat workflow stage table in one set of columns at any panel width, eliding a value that no longer fits instead of letting each row set its own layout.
  ko: 채팅 워크플로 단계 표가 패널 폭과 무관하게 같은 열을 유지하고, 넘치는 값은 행마다 폭이 달라지는 대신 말줄임으로 접힙니다.
- Show a gateway model in the chat workflow stage table by its own name, without the routing alias every row repeated.
  ko: 채팅 워크플로 단계 표에서 게이트웨이 모델을 모든 행이 반복하던 라우팅 별칭 없이 자기 이름으로 보여줍니다.
- Stop a long agent turn from stretching with blank space by no longer drawing a ledger segment whose sentence and steps are both empty.
  ko: 문장도 스텝도 없는 원장 구간을 그리지 않아, 긴 에이전트 턴이 빈 여백으로 늘어나지 않습니다.
- Tighten the ledger rhythm so a folded tool line sits with its own sentence instead of leaving a blank line under it.
  ko: 원장의 간격을 좁혀, 접힌 도구 줄이 아래에 빈 줄을 남기는 대신 자기 문장에 붙어 읽힙니다.
