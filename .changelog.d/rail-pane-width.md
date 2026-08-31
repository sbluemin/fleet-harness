---
branch: rail-pane-width
---

### fleet-console
#### Changed
- Remember Activity Rail panel width per tool, so widening one panel no longer widens every other panel, and a tool you have never resized keeps opening at the width its own panel declares.
  ko: Activity Rail 패널 폭을 도구별로 기억합니다. 한 패널을 넓혀도 나머지 패널이 함께 넓어지지 않고, 한 번도 조절하지 않은 도구는 계속 그 패널이 선언한 폭으로 열립니다.
- Open Settings wide enough for its theme grid to stand in two columns by default.
  ko: 설정 패널이 기본 상태에서 테마 격자를 2열로 세울 만큼 넓게 열립니다.

#### Fixed
- Reset only the active panel's width when you double-click the rail resize handle, leaving every other tool's remembered width in place.
  ko: 레일 크기 조절 손잡이를 더블클릭하면 지금 열린 패널의 폭만 초기화하고, 다른 도구가 기억한 폭은 그대로 둡니다.
