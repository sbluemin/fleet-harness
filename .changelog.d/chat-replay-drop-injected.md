---
branch: chat-replay-drop-injected
---

### fleet-console
#### Fixed
- Stop replaying the agent CLI's own internal lines as messages you sent. Switching an Operation to the chat view no longer shows background-task notifications, slash-command expansions, or local command output as your own chat bubbles, and the replies that followed them stay on their own turns instead of overwriting the previous answer.
  ko: 에이전트 CLI가 트랜스크립트에 남긴 내부 메시지를 사용자가 보낸 말풍선으로 재생하지 않습니다. Operation을 채팅 뷰로 전환해도 백그라운드 작업 알림, 슬래시 명령 확장, 로컬 명령 출력이 더 이상 사용자 말풍선으로 서지 않으며, 그 뒤에 이어진 응답도 앞 턴의 답변을 덮지 않고 자기 턴에 남습니다.
