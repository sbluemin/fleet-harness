---
branch: feat/host-switch-smooth
---

### fleet-desktop
#### Changed
- Switching to another host no longer flashes a blank screen: the current screen stays in place until the other console has finished drawing, then fades across, and a slow connection shows which host it is connecting to.
  ko: 다른 호스트로 전환할 때 더 이상 빈 화면이 깜빡이지 않습니다. 새 콘솔이 다 그려질 때까지 지금 화면이 그대로 있다가 부드럽게 넘어가고, 연결이 느리면 어느 호스트에 연결하는 중인지 보여 줍니다.
- If the other host cannot be opened, the window goes back without a second flash and tells you why.
  ko: 다른 호스트를 열지 못하면 창이 다시 깜빡이지 않고 돌아오며 그 이유를 알려 줍니다.
