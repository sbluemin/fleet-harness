---
branch: quaker-aides-product-review
---

### fleet-console
#### Added
- Quaker aides get a shared model and effort picker in their Settings card (Claude aliases plus AI Gateway models), a one-time introduction bubble on first duty, and a Ctrl/Cmd+Shift+Q shortcut that opens the last aide you spoke with.
  ko: 퀘이커 부관단 설정 카드에 부관단 공통 모델·강도 선택기(Claude 별칭과 AI Gateway 모델), 첫 출근 때 한 번 뜨는 소개 말풍선, 마지막으로 말을 건 부관을 여는 Ctrl/Cmd+Shift+Q 단축키가 생겼습니다.
- The aide chat card now keeps the whole conversation in view with a multi-line composer (Shift+Enter for a new line), a Stop button while an answer streams, Copy and Send to Quick Launch actions on the last answer, source chips for pages the aide read, a token and cost line per answer, and a Clear chat button.
  ko: 부관 대화 카드가 대화 전체를 보여 주며, 여러 줄 입력(Shift+Enter 줄바꿈), 답변 중 「멈추기」, 마지막 답의 「답 복사」·「Quick Launch로 보내기」, 부관이 읽은 페이지의 출처 칩, 답마다 토큰·비용 한 줄, 「대화 지우기」를 갖췄습니다.
- Aides announce Operations waiting for your input with a bubble that opens the Operation, alongside the existing start and finish notices.
  ko: 부관이 입력을 기다리는 Operation을 말풍선으로 알리고, 누르면 그 Operation을 엽니다. 기존 시작·완료 알림과 나란히 섭니다.
- Aides can be moved with the arrow keys and moored with Space when focused, and their chirps are announced to assistive technology.
  ko: 부관에 포커스를 두고 방향키로 옮기거나 Space로 제자리에 둘 수 있고, 지저귐이 보조 기술에 읽힙니다.
#### Changed
- Aides keep clear of open surfaces: they fly out from under the Settings pane, Quick Launch, and dialogs instead of covering their controls, and moored aides return to their spot when the surface closes.
  ko: 부관이 열린 표면을 비켜섭니다. 설정 페인·Quick Launch·대화상자 위에 서지 않고 빠져나오며, 정박한 부관은 표면이 닫히면 제자리로 돌아갑니다.
- When the Console quietly ends an aide's session, the next question starts a new one automatically with a short notice instead of failing; chat errors read as plain sentences with a Try again button, lookup rows settle to "Searched the web" or "Read a source" when the answer completes, and long mention answers scroll inside their bubble.
  ko: Console이 부관 세션을 조용히 거둔 뒤에도 다음 질문이 짧은 알림과 함께 새 세션으로 자동 이어집니다. 대화 오류는 「다시 시도」 버튼이 달린 문장으로 보이고, 조회 행은 답이 끝나면 「웹을 검색함」·「출처 하나를 읽음」으로 정리되며, 긴 멘션 답은 말풍선 안에서 스크롤합니다.
- The plugin is named Quaker Aides wherever it appears, and aides answer in the Console language by default.
  ko: 플러그인이 어디서나 「퀘이커 부관단」으로 불리고, 부관은 기본적으로 Console 언어로 답합니다.
