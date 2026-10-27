---
branch: fix/commodore-alias-in-chat
---

### fleet-console
#### Fixed
- A Commodore with an alias is named by that alias on chat replies and activity lines; without an alias the label stays Commodore.
  ko: 별칭이 있는 사령관은 채팅 응답과 활동 줄에 그 별칭으로 표시되고, 별칭이 없으면 사령관으로 남습니다.
- Changing or clearing a Commodore alias reaches the next turn, so an open session is not stuck with the name from when it started.
  ko: 별칭을 바꾸거나 지우면 다음 턴에 전달되어, 이미 열린 세션이 시작할 때의 이름에 머물지 않습니다.
