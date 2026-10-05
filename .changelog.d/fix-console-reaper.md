---
branch: fix/console-reaper
---

### fleet-console
#### Fixed
- On macOS and Linux, a Console that crashes or is force-killed no longer leaves its agent CLIs, their MCP servers, or plugin work such as Ledger's usage scan, Skills commands, and Repository fetches running in the background.
  ko: macOS와 Linux에서 Console이 비정상 종료되거나 강제로 종료되어도 에이전트 CLI, 그 MCP 서버, 그리고 Ledger 사용량 집계·Skills 명령·Repository fetch 같은 플러그인 작업이 더 이상 백그라운드에 남지 않습니다.
- On macOS and Linux, stopping Console while a plugin task is still running, such as a Repository fetch or a Skills install, now finishes cleanly within seconds instead of waiting 10 seconds and reporting that Console did not shut down cleanly.
  ko: macOS와 Linux에서 Repository fetch나 Skills 설치 같은 플러그인 작업이 진행 중일 때 Console을 종료해도, 10초를 기다린 뒤 깨끗하게 종료되지 않았다고 보고하는 대신 몇 초 안에 정상 종료됩니다.
