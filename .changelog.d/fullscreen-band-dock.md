---
branch: fullscreen-band-dock
---

### fleet-console
#### Changed
- Keeping the command band visible in fullscreen now gives it a place instead of floating it over your work: the stage starts below the band, so nothing is covered and the strip under it stays clickable. A band that only slid down for a moment still floats, because a temporary reveal gives the space straight back.
  ko: 전체 화면에서 커맨드 밴드를 계속 보이게 하면 이제 작업 화면 위에 떠 있지 않고 자기 자리를 갖습니다. 화면이 밴드 아래에서 시작하므로 가려지는 부분이 없고, 그 아래 띠도 그대로 누를 수 있습니다. 잠시 내려왔다 사라지는 밴드는 그대로 떠 있는데, 잠깐 나타나는 표시는 공간을 곧 돌려주기 때문입니다.
- The fullscreen command band also comes down when the pointer moves upward near the top edge, instead of only inside the topmost 8px. The wider approach is watched rather than claimed, so clicks and drags near the top of the canvas still reach the canvas.
  ko: 전체 화면 커맨드 밴드는 최상단 8px 안에서만이 아니라, 위쪽 가장자리 근처에서 포인터가 위로 움직일 때도 내려옵니다. 넓어진 접근 구간은 차지하는 것이 아니라 지켜보기만 하므로, 캔버스 위쪽에서의 클릭과 드래그는 그대로 캔버스에 닿습니다.
- Choosing to keep the fullscreen command band visible is remembered for the next visit, and the command palette can turn it on while the band is hidden and its own controls are out of reach.
  ko: 전체 화면에서 커맨드 밴드를 계속 보이게 한 선택은 다음에도 유지되고, 밴드가 숨어 있어 그 안의 조작이 닿지 않을 때도 명령 팔레트에서 켤 수 있습니다.

#### Fixed
- Command band toggles now look pressed while they are on. The state was announced to assistive technology but painted nothing on screen, so pressing one left no visible trace.
  ko: 커맨드 밴드 토글이 켜져 있는 동안 눌린 모습으로 보입니다. 이 상태는 보조 기술에는 전달되었지만 화면에는 아무것도 그리지 않아, 눌러도 눈에 보이는 흔적이 남지 않았습니다.
