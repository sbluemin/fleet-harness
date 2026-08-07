---
branch: terminal-drag-copy
---

### fleet-console
#### Fixed
- Copying by dragging in a terminal panel now works while a full-screen agent CLI is running. A full-screen CLI takes the mouse over, draws its own selection, and reports the copy with `OSC 52`, which the terminal discarded, so a drag highlighted the text and pasting produced nothing. Clipboard writes the running program asks for are now applied; a clipboard read request is still refused, so a program cannot take what it did not put there.
  ko: 전체 화면 agent CLI가 실행 중일 때도 터미널 패널에서 마우스 드래그로 복사됩니다. 전체 화면 CLI는 마우스를 가져가 자신의 선택을 직접 그리고 복사 결과를 `OSC 52`로 알리는데, 터미널이 이를 버려서 드래그로 글자가 반전돼도 붙여넣으면 아무것도 나오지 않았습니다. 이제 실행 중인 프로그램이 요청한 클립보드 쓰기를 반영하며, 클립보드 읽기 요청은 계속 거부하므로 프로그램이 자신이 넣지 않은 내용을 가져갈 수 없습니다.
