---
branch: background-pending-live-tasks
---

### fleet-console
#### Fixed
- A Claude Operation that leaves a workflow running in the background now stays marked as background work until that workflow actually finishes. One workflow call reports a single start but one finish per workflow agent, so the panel used to drop out of `BACKGROUND` the moment its first agent finished and then surface as an arrival in `AWAITING`. The badge now follows the session's live background-task list instead of a running tally. It holds in the other direction too: a named agent stays registered with the session after it finishes so it can be given more work, and the panel no longer mistakes that resident entry for work still in flight, so the Operation returns to `AWAITING` as soon as the turn ends instead of sitting in `BACKGROUND` with nothing running.
  ko: 워크플로우를 백그라운드에 남긴 채 진행하는 Claude Operation이 그 워크플로우가 실제로 끝날 때까지 백그라운드 작업으로 표시됩니다. 워크플로우 1건은 시작을 한 번만 알리지만 종료는 워크플로우 에이전트 수만큼 알리기 때문에, 지금까지는 첫 에이전트가 끝나는 순간 패널이 `BACKGROUND`에서 빠지고 도착 항목으로 `AWAITING`에 나타났습니다. 이제 배지는 누적 집계 대신 세션에 살아 있는 백그라운드 작업 목록을 따릅니다. 반대 방향도 마찬가지입니다. 이름을 붙인 에이전트는 일을 마친 뒤에도 다시 지시를 받으려고 세션에 등록된 채 남는데, 이제 패널이 그 상주 항목을 진행 중인 작업으로 잘못 읽지 않으므로, 아무것도 돌지 않는데 `BACKGROUND`에 머무는 대신 턴이 끝나는 즉시 Operation이 `AWAITING`으로 돌아옵니다.
