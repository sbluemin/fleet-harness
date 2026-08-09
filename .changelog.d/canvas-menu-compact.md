---
branch: canvas-menu-compact
---

### fleet-console
#### Changed
- The canvas context menu is roughly half as tall. Its icon-and-title masthead collapses into one line that names what you are launching into and carries the `Launch` label, the plugin name joins that line when a single plugin supplies the kinds, and every row is a single line. Measured on a four-row menu it comes to 288x168 instead of 340x307, and 115px of chrome ahead of the first action becomes 31px. Each Claude launch kind shows a short contrast beside its name, and its full one-line description opens next to the menu when you point at that row or move keyboard focus to it, rather than sitting under every row at all times; a kind that opens a submenu of its own keeps the description off screen because the submenu takes that space, and screen readers still read it on every row.
  ko: 캔버스 컨텍스트 메뉴가 절반 가까이 낮아집니다. 아이콘과 제목이 차지하던 머리글이 한 줄로 접혀 무엇으로 실행하는지와 `Launch` 라벨을 함께 싣고, 플러그인 하나가 실행 종류를 모두 제공할 때는 플러그인 이름도 그 줄에 붙으며, 모든 항목이 한 줄이 됩니다. 네 줄짜리 메뉴 기준으로 340x307에서 288x168이 되고, 첫 항목 앞을 막던 크롬 115px는 31px가 됩니다. Claude 실행 종류마다 이름 옆에 짧은 대비 문구가 서고 한 줄 설명 전문은 해당 항목을 가리키거나 키보드 포커스를 옮겼을 때 메뉴 옆에 펼쳐져, 설명이 모든 항목 아래에 상시로 깔리지 않습니다. 자기 서브메뉴를 여는 종류는 그 자리를 서브메뉴가 쓰므로 설명을 띄우지 않으며, 화면 낭독기는 모든 항목에서 설명을 그대로 읽습니다.

#### Fixed
- Arrow keys move through the canvas context menu again: the first Down arrow enters the list without pre-selecting anything, Up and Down cycle past unavailable kinds, and Home and End jump to the ends. The menu also reports itself as a menu to screen readers, so its items are announced with their position in the list.
  ko: 캔버스 컨텍스트 메뉴에서 방향키가 다시 동작합니다. 아래 방향키를 처음 누르면 아무것도 미리 고르지 않은 채 목록으로 들어가고, 위아래 방향키는 실행할 수 없는 종류를 건너뛰며 순환하고, Home과 End는 처음과 끝으로 이동합니다. 메뉴가 화면 낭독기에 자신을 메뉴로 알리므로 항목이 목록 안 위치와 함께 읽힙니다.
- Opening the canvas control menu near the bottom of the canvas no longer shoves the whole board upward. The board stayed shifted in Cruise, Tactical, and War Room alike until the page was reloaded; the canvas now keeps its position no matter where the menu opens.
  ko: 캔버스 아래쪽에서 캔버스 제어 메뉴를 열어도 판 전체가 위로 밀리지 않습니다. 한 번 밀리면 Cruise·Tactical·War Room 어디로 옮겨도 밀린 채 남고 새로고침해야 돌아왔지만, 이제는 메뉴를 어디서 열든 캔버스가 제자리를 지킵니다.
- Right-clicking the canvas in Tactical view now offers every launch kind instead of showing them all greyed out with no reason. Launching from the canvas menu matches the sidebar and the launcher, which already launched in that mode, and Tactical keeps gating only canvas gestures such as panning, zooming, and drag-to-create.
  ko: Tactical 뷰에서 캔버스를 우클릭하면 실행 종류가 사유 없이 모두 회색이던 문제를 고쳐, 이제 모든 실행 종류를 그대로 제공합니다. 캔버스 메뉴 실행이 이미 그 모드에서 실행되던 사이드바·런처와 같아지며, Tactical은 팬·줌·드래그 생성 같은 캔버스 제스처만 계속 막습니다.
