---
branch: feat/browser-agent-control
---

### fleet-desktop
#### Added
- While an agent is working in a Fleet Browser tab, your clicks and keys no longer reach that page, and a pill at the bottom lets you take over, hand control back, or stop the agent. The agent is told when you take over, waits until you return control, and can ask you for a step such as signing in; a space waiting on you is marked in the space grid.
  ko: 에이전트가 플릿 브라우저 탭에서 작업하는 동안에는 내 클릭과 키 입력이 그 페이지에 닿지 않고, 아래쪽 알약에서 제어를 가져오거나 돌려주거나 에이전트를 중지할 수 있습니다. 에이전트는 내가 제어를 가져간 것을 알고 돌려줄 때까지 기다리며, 로그인처럼 내가 해야 하는 단계를 요청할 수 있습니다. 나를 기다리는 스페이스는 스페이스 그리드에 표시됩니다.
#### Changed
- The page itself now shows that an agent is working in it, with an animation and the agent's moving cursor, instead of tinting the address bar and tab strip. None of it appears in the screenshots the agent takes.
  ko: 에이전트가 작업 중이라는 표시가 주소 표시줄과 탭 표시줄의 색 대신 페이지 화면의 애니메이션과 움직이는 에이전트 커서로 바뀌었습니다. 이 표시는 에이전트가 찍는 스크린샷에는 나오지 않습니다.
