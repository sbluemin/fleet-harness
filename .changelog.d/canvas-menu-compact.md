---
branch: canvas-menu-compact
---

### fleet-console
#### Changed
- The canvas context menu is roughly half as tall. Its icon-and-title masthead collapses into one line that names what you are launching into and carries the `Launch` label, the plugin name joins that line when a single plugin supplies the kinds, and every row is a single line. Measured on a four-row menu it comes to 288x168 instead of 340x307, and 115px of chrome ahead of the first action becomes 31px.
  ko: 캔버스 컨텍스트 메뉴가 절반 가까이 낮아집니다. 아이콘과 제목이 차지하던 머리글이 한 줄로 접혀 무엇으로 실행하는지와 `Launch` 라벨을 함께 싣고, 플러그인 하나가 실행 종류를 모두 제공할 때는 플러그인 이름도 그 줄에 붙으며, 모든 항목이 한 줄이 됩니다. 네 줄짜리 메뉴 기준으로 340x307에서 288x168이 되고, 첫 항목 앞을 막던 크롬 115px는 31px가 됩니다.
- Each Claude launch kind now shows a short contrast beside its name, and its full one-line description opens next to the menu when you point at that row or move keyboard focus to it. A kind that opens a submenu of its own keeps the description off screen, since the submenu takes that space. The description no longer sits under every row at all times, and screen readers still read it on every row regardless of what is on screen.
  ko: Claude 실행 종류마다 이름 옆에 짧은 대비 문구가 서고, 한 줄 설명 전문은 해당 항목을 가리키거나 키보드 포커스를 옮겼을 때 메뉴 옆에 펼쳐집니다. 자기 서브메뉴를 여는 종류는 그 자리를 서브메뉴가 쓰므로 설명을 화면에 띄우지 않습니다. 설명이 모든 항목 아래에 상시로 깔리지 않으며, 화면 낭독기는 표시 여부와 무관하게 모든 항목에서 설명을 그대로 읽습니다.

#### Fixed
- Arrow keys move through the canvas context menu again: the first Down arrow enters the list without pre-selecting anything, Up and Down cycle past unavailable kinds, and Home and End jump to the ends. The menu also reports itself as a menu to screen readers, so its items are announced with their position in the list.
  ko: 캔버스 컨텍스트 메뉴에서 방향키가 다시 동작합니다. 아래 방향키를 처음 누르면 아무것도 미리 고르지 않은 채 목록으로 들어가고, 위아래 방향키는 실행할 수 없는 종류를 건너뛰며 순환하고, Home과 End는 처음과 끝으로 이동합니다. 메뉴가 화면 낭독기에 자신을 메뉴로 알리므로 항목이 목록 안 위치와 함께 읽힙니다.
