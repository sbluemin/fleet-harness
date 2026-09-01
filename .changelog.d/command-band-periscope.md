---
branch: command-band-periscope
---

### fleet-console
#### Changed
- Session search moved to the center of the command band, right of the mode switch, and stays there on every view as the one global entry point.
  ko: 세션 검색이 커맨드 밴드 중앙, 모드 스위치 오른쪽으로 이동해 어느 화면에서든 하나의 전역 진입구로 상주합니다.
- Collapsing the sidebar and the Activity Rail now belongs to each panel itself: a collapse control inside the panel folds it away, and the same Cmd+B / Cmd+Alt+B shortcuts keep toggling the same states.
  ko: 사이드바와 Activity Rail 접기가 각 패널 자신의 컨트롤로 옮겨졌습니다. 패널 안의 접기 버튼이 패널을 접고, Cmd+B / Cmd+Alt+B 단축키는 같은 상태를 그대로 토글합니다.
#### Added
- A collapsed panel leaves a slim brass filament on the screen edge: hovering it peeks the panel over the canvas without moving anything, and clicking it (or the pin inside the peek) docks the panel back open.
  ko: 접힌 패널은 화면 가장자리에 얇은 brass 필라멘트를 남깁니다. 필라멘트에 마우스를 올리면 캔버스 배치를 건드리지 않고 패널이 오버레이로 살짝 나타나고, 클릭하거나 미리보기 안의 고정 버튼을 누르면 다시 열린 상태로 고정됩니다.
#### Removed
- The two panel collapse buttons left the command band; the band keeps only identity, canvas mode, search, and system controls.
  ko: 커맨드 밴드의 좌·우 패널 접기 버튼 2개를 제거했습니다. 밴드에는 정체·캔버스 모드·검색·시스템 컨트롤만 남습니다.
