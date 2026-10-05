---
branch: fix/obj7c3063ad-signal-lifetime
---

### fleet-console
#### Fixed
- Stopping Console no longer leaves agent processes running in the background when another stop request, such as a logout or a repeated `kill`, arrives while it is still shutting down. A Console whose shutdown gets stuck now ends itself within about 10 seconds and stops its agent processes first.
  ko: 종료 중인 Console에 로그아웃이나 반복된 `kill` 같은 종료 요청이 한 번 더 와도 에이전트 프로세스가 백그라운드에 남지 않습니다. 종료가 멈춘 Console은 이제 약 10초 안에 에이전트 프로세스를 먼저 정리한 뒤 스스로 종료합니다.
