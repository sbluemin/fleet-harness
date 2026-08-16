---
branch: chat-sse-starvation
---

### fleet-console
#### Fixed
- Keep Console APIs reachable when several Chat Mode panels are open by moving each chat journal off HTTP/1.1 EventSource onto the same ticketed WebSocket path the terminal already uses.
  ko: 채팅 뷰를 여러 개 열어도 콘솔 API가 멈추지 않도록, 채팅 저널을 HTTP/1.1 EventSource에서 터미널과 같은 티켓 WebSocket으로 옮겼습니다.
