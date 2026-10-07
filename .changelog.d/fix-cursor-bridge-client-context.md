---
branch: fix/cursor-bridge-client-context
---

### fleet-console
#### Fixed
- Cursor no longer resends the whole conversation when a tool result is followed by a reminder, client instructions, a background-task notice, or a message from another session, so those replies come back sooner and use less of your allowance.
  ko: 도구 결과 뒤에 알림, 클라이언트가 붙인 지시, 백그라운드 작업 알림, 다른 세션의 메시지가 와도 Cursor가 대화 전체를 다시 보내지 않아, 그 응답이 더 빨라지고 사용 한도를 덜 씁니다.
