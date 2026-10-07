---
branch: fix/cursor-bridge-client-context
---

### fleet-console
#### Fixed
- Cursor no longer resends the whole conversation when a tool result is followed by a reminder, client instructions, a background-task notice, or a message from another session, so those replies come back sooner and use less of your allowance.
  ko: 도구 결과 뒤에 알림, 클라이언트가 붙인 지시, 백그라운드 작업 알림, 다른 세션의 메시지가 와도 Cursor가 대화 전체를 다시 보내지 않아, 그 응답이 더 빨라지고 사용 한도를 덜 씁니다.
- When Cursor rebuilds an older conversation, a compressed search result is readable again, so the model can use that search without running it a second time.
  ko: Cursor가 이전 대화를 다시 올릴 때 압축되어 있던 검색 결과를 다시 읽을 수 있어, 같은 검색을 한 번 더 돌리지 않고 이어서 답합니다.
- Cursor no longer treats a doubled first reading of a conversation as a full window, so the chat is not summarized early and the usage meter does not jump to its ceiling.
  ko: Cursor가 대화의 첫 측정을 두 배로 읽어 창이 가득 찼다고 보지 않아, 대화가 일찍 요약되지 않고 사용량 표시가 한도까지 뛰지 않습니다.
