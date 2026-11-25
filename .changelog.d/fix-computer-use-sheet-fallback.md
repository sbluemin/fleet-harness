---
branch: fix/computer-use-sheet-fallback
---

### fleet-console
#### Fixed
- Computer Use can now press buttons in save and open sheets, such as Delete when closing an unsaved TextEdit document, without bringing the app to the front.
  ko: Computer Use가 저장·열기 시트의 버튼(예: 저장하지 않은 텍스트 편집기 문서를 닫을 때의 삭제)을 앱을 앞으로 가져오지 않고 누를 수 있습니다.
- The key name `delete` now sends the Mac Delete (backspace) key; use `forwarddelete` for forward delete.
  ko: 키 이름 `delete`가 이제 맥의 Delete 키(⌫)를 보냅니다. ⌦는 `forwarddelete`를 쓰세요.

#### Added
- When background input has no effect, such as on a virtual machine screen, an agent can choose a foreground fallback that briefly brings the app to the front, then returns focus to your app and reports the switch. Your pointer is not moved.
  ko: 가상 머신 화면처럼 백그라운드 입력이 통하지 않을 때 에이전트가 전면 폴백을 고를 수 있습니다. 앱을 잠깐 앞으로 가져온 뒤 사용하던 앱으로 포커스를 되돌리고 전환 사실을 알립니다. 마우스 포인터는 움직이지 않습니다.
