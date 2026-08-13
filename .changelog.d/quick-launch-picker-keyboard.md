---
branch: quick-launch-picker-keyboard
---

### fleet-console
#### Changed
- Quick Launch picker menus now follow the standard menu keyboard grammar: opening a picker focuses the current choice, arrow keys and Home/End move through the list, typing a letter jumps to a matching entry, Enter picks and returns to the prompt, and Escape returns to the chip.
  ko: Quick Launch 선택 메뉴가 표준 메뉴 키보드 문법을 따릅니다. 메뉴를 열면 현재 선택 항목에 포커스가 들어가고, 방향키와 Home/End로 목록을 이동하며, 글자를 치면 일치하는 항목으로 점프하고, Enter는 선택 후 입력창으로, Escape는 칩으로 돌아갑니다.
#### Fixed
- The focus ring on the Theater and model chips draws as a complete ring instead of two clipped side arcs.
  ko: Theater·모델 칩의 포커스 링이 좌우 호 두 개로 잘리지 않고 온전한 링으로 그려집니다.
- Closing Quick Launch with Escape no longer discards a typed prompt; reopening restores the draft.
  ko: Escape로 Quick Launch를 닫아도 입력한 문장이 사라지지 않으며, 다시 열면 초안이 복원됩니다.
