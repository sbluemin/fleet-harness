---
branch: fix/windows-stop-request
---

### fleet-console
#### Fixed
- On Windows, stopping Console now shuts it down cleanly, closing out agent work in progress the same way as on macOS and Linux instead of cutting it off.
  ko: Windows에서 Console을 멈추면 진행 중인 에이전트 작업을 macOS 및 Linux와 마찬가지로 정리하며 정상 종료됩니다.

### fleet-desktop
#### Fixed
- On Windows, quitting the app now lets the Console finish shutting down first, so agent work in progress is closed out instead of being cut off.
  ko: Windows에서 앱을 종료하면 Console이 먼저 종료를 마치도록 기다리므로 진행 중인 에이전트 작업이 중단되지 않고 정리됩니다.
