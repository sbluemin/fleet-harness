---
branch: chat-background-pending
---

### fleet-console
#### Fixed
- Show a chat Operation as background while subagents or workflows keep running after its turn ends, instead of reading as idle until they finish.
  ko: 채팅 Operation의 턴이 끝난 뒤에도 서브에이전트나 워크플로가 계속 돌고 있으면 유휴 대신 백그라운드로 표시합니다.
- Stop counting background work Fleet does not recognize as agent work toward an Operation's background state.
  ko: Fleet이 에이전트 작업으로 알아보지 못하는 백그라운드 작업은 Operation의 백그라운드 상태로 세지 않습니다.
