---
branch: chat-born-replay-banner
---

### fleet-console
#### Fixed
- Stop labeling a chat-born session's own restored turns as replayed: reopening or reconnecting to a Chat Mode session that started as chat no longer shows the "earlier turns replayed" notice, which had wrongly implied a prior conversation. A session adopted from a terminal still shows it, since those turns did happen on another surface.
  ko: 채팅으로 시작한 세션이 자기 턴을 되살릴 때 이를 재생된 과거로 표시하지 않습니다. 채팅으로 태어난 Chat Mode 세션을 다시 열거나 재연결해도 "이전 턴 재생됨" 안내가 더 이상 뜨지 않아, 없던 이전 대화가 있었던 것처럼 오독되지 않습니다. 터미널에서 넘어온 세션은 그 턴이 실제로 다른 표면에서 오갔으므로 안내를 그대로 표시합니다.
