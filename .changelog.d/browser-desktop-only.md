---
branch: browser-desktop-only
---

### fleet-console
#### Changed
- The Operation Browser is now a Fleet Desktop feature: tabs render as real browser views inside the Desktop window, whether that window shows your own Console or a remote one you joined. Console no longer looks for a Chrome installation, so the browser engine path setting is gone; importing cookies from Google Chrome still works and now reads the Chrome profiles on the computer running Fleet Desktop.
  ko: Operation 브라우저가 Fleet Desktop 전용 기능이 됩니다. 탭은 Desktop 창 안의 실제 브라우저 뷰로 그려지며, 그 창이 내 Console을 보든 원격으로 접속한 Console을 보든 같습니다. Console이 더 이상 Chrome 설치를 찾지 않으므로 브라우저 엔진 경로 설정은 사라지지만, Google Chrome 쿠키 가져오기는 그대로 쓸 수 있고 이제 Fleet Desktop이 실행 중인 컴퓨터의 Chrome 프로필을 읽습니다.
- Opening a Console in a regular browser tab or on a phone shows the browser button disabled with a note that it needs Fleet Desktop, and agents get the same answer from their browser tools. While such a screen is connected, the Desktop browser pauses and closes its tabs; it resumes once only Desktop windows remain.
  ko: 일반 브라우저 탭이나 휴대폰에서 Console을 열면 브라우저 버튼이 비활성화되고 Fleet Desktop이 필요하다는 안내가 보이며, 에이전트의 브라우저 도구도 같은 답을 받습니다. 그런 화면이 연결되어 있는 동안 Desktop의 브라우저는 탭을 닫고 멈추며, Desktop 창만 남으면 다시 열립니다.
#### Fixed
- Closing one of several browser tabs now shows the remaining tab instead of a blank pane.
  ko: 브라우저 탭이 여러 개일 때 하나를 닫으면 남은 탭이 빈 화면 대신 바로 보입니다.
- Panels that open above the browser, such as the right-rail extension surface, now stay in front of it, and the outline shown while the agent is driving is no longer hidden behind the page.
  ko: 우측 레일의 확장 표면처럼 브라우저 위에 열리는 패널이 이제 브라우저에 가려지지 않고 앞에 보이며, 에이전트가 조작 중일 때의 테두리도 페이지 뒤로 숨지 않습니다.
