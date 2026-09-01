---
branch: analyst-refit
---

### fleet-console

#### Changed
- Session Analyst artifacts now share the Console's design language: pages sit on the panel ground with raised cards, quiet section kickers, the Console's own typefaces, a centered reading column, and a host component set that keeps every artifact consistent across all four themes.
  ko: 세션 분석가 아티팩트가 콘솔의 디자인 언어를 그대로 잇습니다. 문서가 패널면 위에 앉고, 카드가 위로 들리며, 조용한 섹션 키커·콘솔 서체·중앙 읽기 컬럼·호스트 컴포넌트 세트가 네 테마 전부에서 일관된 아티팩트를 보장합니다.
- The Session Analyst chat now speaks the chat view's ledger grammar: process sentences and tool steps stack as segments while streaming, finished turns fold into one line, and the confirmed answer stands alone under its own seam instead of merging with interim narration.
  ko: 세션 분석가 채팅이 채팅뷰의 원장 문법으로 말합니다. 스트리밍 중에는 과정 문장과 도구 스텝이 구간으로 쌓이고, 끝난 턴은 한 줄로 접히며, 확정 답변은 중간 서술과 병합되지 않고 응답 구분선 아래 홀로 섭니다.
- The analyst composer now uses the chat view's assembly, with the input above a coordinates rail that stays after the first question, and the initial centered composer settles to the bottom when streaming starts, the same motion the chat view uses.
  ko: 분석가 입력창이 채팅뷰와 같은 조립을 씁니다. 입력 위층과 좌표 레일 아래층이 첫 질문 뒤에도 유지되고, 초기 중앙 입력창은 채팅뷰와 같은 모션으로 스트리밍 시작과 함께 하단에 내려앉습니다.

#### Fixed
- Long analyses no longer die at two minutes: the fixed 120-second response cap became an inactivity watchdog that rearms on every streamed event, so artifact authoring and other long turns keep running as long as they keep reporting.
  ko: 긴 분석이 2분에서 죽지 않습니다. 고정 120초 응답 상한이 이벤트 수신마다 재무장되는 무활동 감시로 바뀌어, 아티팩트 저작 같은 긴 턴이 이벤트를 보내는 한 계속 진행됩니다.
- Evidence citations in analyst chat replies no longer surface as raw cite markup when the model uses the artifact citation form; they render as the same evidence chips everywhere.
  ko: 분석가 채팅 응답의 근거 인용이 모델이 아티팩트 인용 표기를 쓰더라도 원문 마크업으로 노출되지 않고, 어디서든 같은 증거 칩으로 렌더됩니다.
