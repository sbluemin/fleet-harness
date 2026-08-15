---
branch: xterm-beta-sync-render
---

### fleet-console
#### Fixed
- Stop the terminal from flashing blank for a frame when its panel is resized, such as when the side bar is collapsed or expanded.
  ko: 사이드바를 접거나 펼쳐 패널 크기가 바뀔 때 터미널이 한 프레임 동안 빈 화면으로 번쩍이던 문제를 고쳤습니다.
- Let the terminal catch up to its panel as soon as the side bar finishes moving, instead of staying clipped for roughly half a second afterwards.
  ko: 사이드바를 접거나 펼친 뒤 터미널이 0.5초 남짓 잘린 채 남아 있다가 뒤늦게 맞춰지던 것을, 사이드바가 멈추는 즉시 따라오도록 고쳤습니다.
- Stop asking the shell to redraw its whole screen when a resize leaves the character grid unchanged, such as a drag smaller than one cell.
  ko: 한 글자 크기보다 작은 드래그처럼 문자 격자가 그대로인 리사이즈에서 셸에 전체 화면을 다시 그리게 하던 요청을 없앴습니다.
