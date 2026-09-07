---
branch: caption-menu-proposal
---

### fleet-console
#### Changed
- The Operation menu opened from a panel caption, a sidebar chip, or a group header shows the nine accent tones as one row of swatches with the aimed tone's name read out beside the label, replacing the nine-row list; the card uses plain sans-serif section labels, borderless rows, a check mark for the current group, and a neutral shadow.
  ko: 패널 캡션·사이드바 칩·그룹 헤더에서 여는 Operation 메뉴가 액센트 9색을 한 줄의 스와치로 보여 주고, 겨눈 색의 이름을 라벨 옆에 읽어 줍니다. 9행 목록은 사라지고, 카드는 산세리프 섹션 라벨·테두리 없는 행·현재 그룹의 체크 표시·중립 그림자를 씁니다.
- A panel's accent now colors the caption title itself; the accent bar that stood before the title is gone. The sidebar chip spine and minimap dot still carry the accent.
  ko: 패널의 액센트가 이제 캡션 제목 글자를 물들이고, 제목 앞에 서던 액센트 막대는 사라졌습니다. 사이드바 칩의 스파인과 미니맵 도트는 그대로 액센트를 보여 줍니다.
- The caption's more button draws its three dots on the same 14px grid as the window controls, highlights with the same brass hover, and stays lit while its menu is open.
  ko: 캡션의 더보기 버튼이 창 컨트롤과 같은 14px 격자에 점 세 개를 그리고, 같은 brass hover로 밝아지며, 메뉴가 열린 동안 켜진 상태를 유지합니다.
#### Fixed
- The caption menu opens inward from the more button's right edge instead of spilling past the panel, measures its own height before choosing to open above or below, and stays inside a short viewport; opening it with Enter now moves focus into the menu, and Left/Right arrows step across the accent swatches.
  ko: 캡션 메뉴가 더보기 버튼 오른쪽 변에서 패널 안쪽으로 열려 패널 밖으로 삐져나가지 않고, 위·아래 방향을 실제 높이로 정하며, 낮은 화면에서도 뷰포트 안에 머뭅니다. Enter로 열면 포커스가 메뉴 안으로 들어가고, 좌우 화살표로 액센트 스와치를 오갈 수 있습니다.
- The selected row in the Operation menu no longer takes a green or pink border produced by hue interpolation, and the caption's more tooltip no longer lingers behind the open menu.
  ko: Operation 메뉴의 선택 행에 색상각 보간으로 생기던 초록·분홍 테두리가 사라졌고, 캡션 더보기 말풍선이 열린 메뉴 뒤에 남지 않습니다.
