---
branch: quick-launch-composer
---

### fleet-console
#### Added
- Start work from anywhere with Mod+J: type what the agent should do, pick the Theater and the model with its reasoning effort, and press Enter to open a Claude (Gateway) Operation that is already working on it.
  ko: 어디에 있든 Mod+J로 작업을 시작합니다. 시킬 일을 적고 Theater와 모델·추론 강도를 고른 뒤 Enter를 누르면, 이미 그 일을 하고 있는 Claude (Gateway) Operation이 열립니다.
- Choose the model and the reasoning effort inside the composer itself: the model from a popover, the effort from the track beside the model chip.
  ko: 모델과 추론 강도를 컴포저 안에서 그대로 고릅니다. 모델은 팝오버에서, 강도는 모델 칩 옆 트랙에서 정합니다.
- Aim a launch at any Theater, not only the one on screen, and read which Theater it will land in from the chip the composer opens with. Choosing another Theater switches to it and brings up the new Operation there.
  ko: 화면에 떠 있는 Theater뿐 아니라 어느 Theater로든 실행을 겨눕니다. 어디로 갈지는 컴포저가 열릴 때 띄우는 칩에서 바로 읽히고, 다른 Theater를 고르면 그쪽으로 전환하며 새 Operation을 그 자리에 띄웁니다.
- Reuse the last Theater, model and reasoning effort you selected, even after closing the composer without launching, so a repeat launch is one shortcut and one sentence.
  ko: 실행하지 않고 컴포저를 닫아도 마지막으로 고른 Theater·모델·추론 강도를 그대로 다시 씁니다. 반복 실행은 단축키 하나와 문장 하나로 끝납니다.
- Keep the composer centered horizontally and vertically in the Console viewport instead of anchoring it near the top edge.
  ko: 컴포저를 화면 위쪽에 붙이지 않고 Console 화면의 가로·세로 정중앙에 표시합니다.
- Open the composer while a terminal has focus; the shortcut is not swallowed by the Operation you are looking at.
  ko: 터미널에 포커스가 있는 상태에서도 컴포저가 열립니다. 보고 있던 Operation이 단축키를 삼키지 않습니다.
- Keep the composer and its draft open when a prompt is too long, and refuse a prompt that a Windows command shim would rewrite before the agent reads it, instead of launching with corrupted text.
  ko: 프롬프트가 너무 길면 컴포저와 초안을 그대로 두고, Windows 명령 shim이 에이전트에 닿기 전에 바꿔 버릴 프롬프트는 실행하지 않고 거부합니다.
