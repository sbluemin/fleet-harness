---
branch: fix/console-reaper
---

### fleet-console
#### Fixed
- On macOS and Linux, a Console that crashes or is force-killed no longer leaves its agent CLIs, their MCP servers, or Ledger's usage scan running in the background.
  ko: macOS와 Linux에서 Console이 비정상 종료되거나 강제로 종료되어도 에이전트 CLI, 그 MCP 서버, Ledger의 사용량 집계 프로세스가 더 이상 백그라운드에 남지 않습니다.
