---
branch: fix/obj32d92b98-sidecar-shutdown
---

### fleet-desktop
#### Fixed
- Quitting or restarting Desktop while a chat is replying no longer leaves its agent processes running in the background. Desktop now lets Console finish shutting down and force-stops it only when it is confirmed stuck, and Quit still completes if Console cannot be stopped.
  ko: 채팅이 답하는 중에 Desktop을 종료하거나 다시 시작해도 에이전트 프로세스가 백그라운드에 남지 않습니다. 이제 Desktop은 Console이 종료를 마칠 때까지 기다리고, 멈춘 것이 확인된 경우에만 강제로 종료합니다. Console을 멈추지 못해도 Desktop 종료는 끝까지 진행됩니다.
