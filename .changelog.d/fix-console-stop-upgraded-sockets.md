---
branch: fix-console-stop-upgraded-sockets
---

### fleet-console
#### Fixed
- Console now shuts down right away when quit or restarted for an update while a terminal or chat is open, instead of hanging until it is force-stopped.
  ko: 터미널이나 채팅이 열려 있을 때 Console을 종료하거나 업데이트로 다시 시작해도, 강제 종료될 때까지 멈춰 있지 않고 바로 내려갑니다.
