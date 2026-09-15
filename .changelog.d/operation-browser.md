---
branch: operation-browser
---

### fleet-console
#### Added
- Operation Browser: each agent Operation can open its own browser panel beside the session, and the agent gets Fleet browser tools (navigate, read the page, click, type, screenshots, console and network logs) on the same tabs you see.
  ko: Operation 브라우저: 에이전트 Operation마다 세션 옆에 자기 브라우저 패널을 열 수 있고, 에이전트는 사용자와 같은 탭에서 Fleet 브라우저 도구(이동·페이지 읽기·클릭·입력·스크린샷·콘솔·네트워크 로그)를 씁니다.
- Annotate the page in the browser panel: click an element to leave a numbered comment on it, or draw with the pen, arrow and rectangle, then attach. The marked screenshot goes to the clipboard and is pasted into that Operation's own input - the chat composer or the terminal's CLI - and you press Enter to send.
  ko: 브라우저 패널에서 페이지에 주석을 답니다. 요소를 클릭해 번호 댓글을 남기거나 펜·화살표·사각형으로 그린 뒤 첨부하면, 표시된 스크린샷이 클립보드에 올라가 그 Operation의 입력창(채팅 컴포저 또는 터미널 CLI)에 붙여넣어집니다. 보내는 것은 Enter입니다.
- While the agent is using the browser, the Operation's browser button and the companion panel show it - the button turns the agent-control color with a spreading ring, the panel gets a moving outline and a tinted caption - from the first browser call until the turn ends.
  ko: 에이전트가 브라우저를 쓰는 동안 Operation의 브라우저 버튼과 companion 패널이 그것을 보여 줍니다. 버튼은 에이전트 제어 색으로 채워지며 링이 퍼지고, 패널은 움직이는 윤곽선과 색조 캡션을 갖습니다. 첫 브라우저 호출부터 턴이 끝날 때까지 이어집니다.
- Console Use and Computer Use show the same way: while the agent uses them, the Operation's window outline carries a moving light in that channel's color, the caption is tinted, and the caption badge pulses - in every layout including War Room cards. Computer Use lets go of the device when the turn ends.
  ko: Console Use와 Computer Use도 같은 방식으로 보입니다. 에이전트가 쓰는 동안 Operation 창의 바깥선을 그 채널 색의 빛이 돌고, 캡션이 물들며, 캡션 배지가 맥동합니다. War Room 카드를 포함한 모든 배치에서 같습니다. Computer Use는 턴이 끝나면 기기를 놓습니다.
- The companion caption is the tab strip: favicons, a new-tab button, cookie import from a Google Chrome profile, and a viewport glyph with a tooltip.
  ko: companion 캡션이 곧 탭 스트립입니다. 파비콘, 새 탭, Google Chrome 프로필의 쿠키 가져오기, 툴팁이 있는 뷰포트 글리프가 한 줄에 있습니다.
- Requires a local Chromium (Google Chrome, Chromium, Microsoft Edge, or a Playwright Chromium). In WSL, Chrome installed on Windows is used when none is installed inside WSL (this needs Node.js on Windows; Fleet Desktop's runtime counts). When no Chrome is found, the browser button is dimmed and its tooltip says what to install.
  ko: 로컬 Chromium(Google Chrome·Chromium·Microsoft Edge 또는 Playwright Chromium)이 필요합니다. WSL에서는 WSL 안에 Chrome이 없으면 Windows에 설치된 Chrome을 씁니다(Windows에 Node.js가 필요하며 Fleet Desktop의 런타임도 됩니다). Chrome을 찾지 못하면 브라우저 버튼이 흐려지고 툴팁이 무엇을 설치할지 알려 줍니다.
