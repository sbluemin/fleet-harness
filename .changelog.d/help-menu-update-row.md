---
branch: help-menu-update-row
---

### fleet-console
#### Changed
- The Help menu now lists what is running as one row per product: a Console row with its version, and a Fleet Desktop row when a Desktop window holds the page. When a newer version exists, the row shows that version at its right edge and becomes the action: the Console row applies the update in place (the "restart this host?" confirmation still takes a second press), and the Desktop row opens the GitHub release page, since Desktop does not update itself. The Help button's dot now lights for either product's update. The former boxed two-line update entry is gone.
  ko: 도움말 메뉴가 실행 중인 것을 제품별 한 행으로 적습니다. Console 행에는 버전이, Desktop 창이 화면을 들고 있으면 Fleet Desktop 행이 함께 섭니다. 새 버전이 있으면 행 오른쪽 끝에 그 버전이 표시되고 행 자체가 동작이 됩니다. Console 행은 그 자리에서 업데이트를 적용하고(「이 호스트를 다시 시작할까요?」 확인은 여전히 두 번째 누름), Desktop은 스스로 업데이트하지 못하므로 GitHub 릴리스 페이지를 엽니다. 도움말 버튼의 점은 두 제품 중 어느 쪽의 업데이트에도 켜집니다. 두 줄로 꺾이던 상자형 업데이트 항목은 사라졌습니다.

### fleet-desktop
#### Changed
- Desktop tells the Console it opens which app version holds the window, so the Console's Help menu can show it and compare it with the latest release; an older Console that does not understand the field still receives the home address as before.
  ko: Desktop이 자기가 연 Console에 창을 든 앱 버전을 알려, Console 도움말 메뉴가 그 버전을 표시하고 최신 릴리스와 비교할 수 있게 합니다. 이 항목을 모르는 옛 Console에도 돌아갈 주소는 이전과 같이 전달됩니다.
