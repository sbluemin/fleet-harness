---
branch: sdk-expanded-surface
---

### fleet-console
#### Added
- Open documents and terminals side by side on an expanded work surface over the canvas, splitting it into as many vertical slots as you need and dragging the dividers to give each one the width it deserves.
  ko: 캔버스 위 확대 작업면에서 문서와 터미널을 나란히 열 수 있습니다. 필요한 만큼 세로 슬롯으로 나누고, 분할선을 끌어 각 슬롯의 폭을 정할 수 있습니다.
- Let plugins contribute their own expanded surfaces, so any plugin can present a full-size work surface instead of only a rail panel.
  ko: 플러그인이 확대 작업면을 직접 기여할 수 있습니다. 레일 패널 외에 전체 크기의 작업면을 제공할 수 있습니다.

#### Changed
- Open Shell as one console-wide terminal on the expanded surface rather than as a separate Operation per Theater, so it no longer takes a canvas panel, a caption, a sidebar row, or a War Room card. Shell starts in the Theater that was active when you opened it and stays there until you close it.
  ko: Shell이 Theater마다 별도 Operation으로 열리는 대신 콘솔 전체에 하나뿐인 터미널로 확대 작업면에 섭니다. 캔버스 패널·캡션·사이드바 행·War Room 카드를 더 이상 차지하지 않습니다. Shell은 열 때 활성이던 Theater에서 시작해 닫을 때까지 그 자리를 지킵니다.

- Press the rail Shell icon again to put the Shell away, and see that icon lit while the Shell is showing. Putting it away is not ending it: the session and its working directory wait where you left them, so pressing once more lands you back in the same place.
  ko: 레일의 Shell 아이콘을 다시 누르면 Shell을 치웁니다. Shell이 떠 있는 동안에는 그 아이콘이 켜져 있어 지금 어디에 있는지 보입니다. 치우는 것은 끝내는 것이 아니라 세션과 작업 디렉터리가 그대로 기다리므로, 다시 누르면 하던 자리로 돌아옵니다.

- Move Codex out of the Console's core and into a plugin of its own, so the knowledge surface is installed and updated like every other panel rather than being welded into the Console itself.
  ko: Codex를 Console 코어에서 분리해 독립 플러그인으로 옮겼습니다. 지식 표면이 콘솔에 붙박이로 박혀 있는 대신 다른 패널과 같은 방식으로 설치·갱신됩니다.

#### Removed
- Retire the saved Shell panels that reopened dormant after a restart, along with their Relaunch card. A Shell now lives only as long as the console it runs in.
  ko: 재시작 후 휴면 상태로 되살아나던 저장된 Shell 패널과 Relaunch 카드를 폐지했습니다. Shell은 이제 실행 중인 콘솔과 수명을 함께합니다.
