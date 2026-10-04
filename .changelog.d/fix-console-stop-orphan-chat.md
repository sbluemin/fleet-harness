---
branch: fix/console-stop-orphan-chat
---

### fleet-cli
#### Fixed
- `fleet console stop`, `restart`, and `fleet update` now wait for Console to finish shutting down, so a chat that was mid-reply no longer leaves its agent processes and temporary files behind. If Console stays stuck for 10 seconds it is force-stopped, and `stop` exits with an error that says what may remain.
  ko: `fleet console stop`, `restart`, `fleet update`가 이제 Console이 종료를 마칠 때까지 기다리므로, 답하던 중이던 채팅이 에이전트 프로세스와 임시파일을 남기지 않습니다. Console이 10초 동안 멈춰 있으면 강제로 종료하며, 이때 `stop`은 남아 있을 수 있는 것을 알리는 오류로 끝납니다.
