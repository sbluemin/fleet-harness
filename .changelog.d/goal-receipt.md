---
branch: goal-receipt
---

### fleet-console
#### Added
- Set a completion condition on an Agent Operation from Fleet, and choose how many continuation checks Claude may spend before the turn is allowed to end.
  ko: Agent Operation에 완료 조건을 Fleet에서 직접 걸고, 턴을 끝내기 전까지 Claude가 쓸 수 있는 연속 확인 횟수를 정합니다.
- Read a goal receipt on the Operation itself: whether it is still being enforced, paused while background work runs, judged met by Claude, stopped at the check limit, or ended without a result.
  ko: 목표 영수증을 Operation에서 바로 읽습니다 — 아직 강제 중인지, 백그라운드 작업으로 유예됐는지, Claude가 충족으로 판정했는지, 확인 한도에서 멈췄는지, 결과 없이 끝났는지.
- Pull the goal open from a tab centred at the bottom of the Operation. The tab reports the goal while closed, pulses while one is being enforced, rides up with the panel as it opens, and closes it again from the same place.
  ko: Operation 하단 가운데 탭을 눌러 목표를 위로 펼칩니다. 닫혀 있을 때도 탭이 목표를 알려 주고, 강제 중에는 박동하며, 펼치면 패널과 함께 올라오고, 같은 자리를 다시 눌러 접습니다.
- Read a goal, and set one, on a single line: state, check ledger, detail and controls share one row, and the detail leads with what the goal is while it runs and with how far the verdict can be trusted once it ends.
  ko: 목표를 읽고 거는 일이 한 줄에서 끝납니다 — 상태·확인 눈금·설명·조작이 한 행에 서고, 설명 칸은 진행 중에는 무엇을 시켰는지를, 끝난 뒤에는 그 판정을 어디까지 믿을 수 있는지를 앞세웁니다.
- Float the goal panel over the terminal instead of sharing its space, so opening or closing a goal never resizes the terminal.
  ko: 목표 패널이 터미널과 자리를 나눠 갖지 않고 그 위에 떠 있습니다. 목표를 여닫아도 터미널이 리사이즈되지 않습니다.
- Warn before resuming a dormant Operation that still carries an unfinished goal, because resuming restarts that goal from zero checks.
  ko: 미완료 목표가 남은 휴면 Operation을 재개하기 전에 경고합니다 — 재개하면 그 목표가 확인 0회부터 다시 시작되기 때문입니다.
- Count the goal ledger against the check limit the running session was actually started with, and say separately when a newly chosen limit only takes effect on the next resume.
  ko: 목표 눈금을 실행 중인 세션이 실제로 들고 뜬 확인 한도로 셉니다. 새로 고른 한도가 다음 재개부터 적용될 때는 그 사실을 따로 알립니다.
