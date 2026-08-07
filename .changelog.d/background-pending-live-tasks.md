---
branch: background-pending-live-tasks
---

### fleet-console
#### Fixed
- A Claude Operation that leaves a workflow running in the background now stays marked as background work until that workflow actually finishes. One workflow call reports a single start but one finish per workflow agent, so the panel used to drop out of `BACKGROUND` the moment its first agent finished and then surface as an arrival in `AWAITING`. The badge now follows the session's live background-task list instead of a running tally.
  ko: 워크플로우를 백그라운드에 남긴 채 진행하는 Claude Operation이 그 워크플로우가 실제로 끝날 때까지 백그라운드 작업으로 표시됩니다. 워크플로우 1건은 시작을 한 번만 알리지만 종료는 워크플로우 에이전트 수만큼 알리기 때문에, 지금까지는 첫 에이전트가 끝나는 순간 패널이 `BACKGROUND`에서 빠지고 도착 항목으로 `AWAITING`에 나타났습니다. 이제 배지는 누적 집계 대신 세션에 살아 있는 백그라운드 작업 목록을 따릅니다.
