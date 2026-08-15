---
branch: quick-launch-view-mode
---

### fleet-console
#### Added
- Quick Launch can start an Operation directly in chat view. Type `/view` and pick Chat view: no terminal opens, and your first message becomes the session's first turn. The choice is remembered, and while it is on the composer says so above the input and draws its own outline, so the launch bar keeps its single row. Switch back any time with "Use terminal view" or `/view`.
  ko: Quick Launch에서 Operation을 채팅뷰로 바로 시작할 수 있습니다. `/view`를 치고 **채팅뷰**를 고르면 터미널이 뜨지 않고, 첫 메시지가 그 세션의 첫 턴이 됩니다. 선택은 기억되며, 켜져 있는 동안에는 입력창 위 안내줄과 카드 외곽선이 그 사실을 말합니다 — 실행 바는 한 줄 그대로입니다. **터미널뷰로**나 `/view`로 언제든 되돌립니다.

#### Fixed
- A chat Operation whose transcript is missing now says so instead of waiting on a connecting message forever, and the terminal button beside it is the way out.
  ko: 트랜스크립트가 없는 채팅 Operation이 "세션에 연결하는 중…"에 머무는 대신 그 사실을 말합니다. 옆의 터미널 버튼이 빠져나가는 길입니다.
