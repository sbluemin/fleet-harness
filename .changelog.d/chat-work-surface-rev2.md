---
branch: chat-work-surface-rev2
---

### fleet-console
#### Added
- Chat Mode can stop a turn that is going the wrong way. The control stands next to the reply button while a turn is in flight, and the turn it closes reads as stopped rather than failed, keeping whatever the model had already written. Background work that was already started keeps running, and the work surface still reports it.
  ko: 채팅 모드에서 엉뚱한 방향으로 가는 턴을 중지할 수 있습니다. 턴이 도는 동안 회신 버튼 옆에 컨트롤이 서고, 그렇게 닫힌 턴은 실패가 아니라 중지로 읽히며 모델이 이미 쓴 내용은 그대로 남습니다. 이미 시작된 백그라운드 작업은 계속 돌고, 작업 면이 그것을 그대로 보고합니다.

#### Fixed
- A collapsed row of tool calls now looks like something you can open before you hover it. The tool's name reads a step brighter than the words around it, and the chevron that opens the row is large enough to see at rest.
  ko: 접힌 도구 호출 줄이 마우스를 올리기 전에도 눌리는 것으로 보입니다. 도구 이름이 주변 문구보다 한 단 밝게 읽히고, 줄을 펴는 꺾쇠가 쉬는 상태에서도 보일 만큼 커졌습니다.
