---
branch: feat/session-keep
---

### fleet-console
#### Added
- Updating Console no longer interrupts running Commodore, commander, and member sessions: they keep their conversation and any turn in progress, while quitting Console still ends them all. Sessions that keep running on the setup they started with, after an update or a Theater system prompt change, show a quiet mark beside their name; new sessions use the current setup. An update waits while a session awaits your permission, and an update that cannot carry the running sessions ends them and says so.
  ko: Console을 업데이트해도 진행 중인 사령관·지휘관·구성원 세션이 끊기지 않고 대화와 진행 중인 턴을 이어 갑니다. Console을 종료하면 이전처럼 모두 끝납니다. 업데이트나 Theater 시스템 프롬프트 변경 뒤에도 시작할 때의 구성으로 계속 도는 세션은 이름 옆에 은은한 표식이 붙고, 새 세션은 지금의 구성으로 시작합니다. 세션이 권한 응답을 기다리는 동안에는 업데이트가 미뤄지며, 실행 중인 세션을 이어 갈 수 없는 업데이트는 세션을 끝내고 그 사실을 알려 줍니다.
