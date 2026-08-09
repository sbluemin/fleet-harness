---
branch: quick-launch-composer
---

### fleet-console
#### Added
- Start work from anywhere with Mod+J: type what the agent should do, pick the Theater and the model with its reasoning effort, and press Enter to open a Claude (Gateway) Operation that is already working on it. The composer sits in the centre of the Console viewport, and the shortcut opens it even while a terminal has focus rather than being swallowed by the Operation you are looking at.
  ko: 어디에 있든 Mod+J로 작업을 시작합니다. 시킬 일을 적고 Theater와 모델·추론 강도를 고른 뒤 Enter를 누르면, 이미 그 일을 하고 있는 Claude (Gateway) Operation이 열립니다. 컴포저는 Console 화면 정중앙에 서고, 터미널에 포커스가 있어도 보고 있던 Operation이 단축키를 삼키지 않고 열립니다.
- Choose the model and the reasoning effort inside the composer itself: the model from a popover that opens under the chip you pressed, the effort from the track beside the model chip. Choosing a model that does not offer the remembered effort clears it instead of launching on a rung that model rejects, a first-time Quick Launch starts on Opus, and the composer sends with a single round button whose esc hint reads as a hint rather than a control.
  ko: 모델과 추론 강도를 컴포저 안에서 그대로 고릅니다. 모델은 누른 칩 아래에 열리는 팝오버에서, 강도는 모델 칩 옆 트랙에서 정합니다. 기억해 둔 강도를 내놓지 않는 모델을 고르면 그 강도를 비워 모델이 거부할 단으로 실행하지 않고, 처음 쓰는 Quick Launch는 Opus로 시작하며, 컴포저는 원형 버튼 하나로 실행하고 esc 힌트는 누를 수 있는 컨트롤이 아니라 힌트로 읽힙니다.
- Aim a launch at any Theater, not only the one on screen. Where it will land is read from the chip the composer opens with, and choosing another Theater switches to it and brings up the new Operation there. The last Theater you launched in, and the last model and reasoning effort you selected, are reused even after closing the composer without launching, so a repeat launch is one shortcut and one sentence.
  ko: 화면에 떠 있는 Theater뿐 아니라 어느 Theater로든 실행을 겨눕니다. 어디로 갈지는 컴포저가 열릴 때 띄우는 칩에서 바로 읽히고, 다른 Theater를 고르면 그쪽으로 전환하며 새 Operation을 그 자리에 띄웁니다. 마지막으로 실행한 Theater와 마지막으로 고른 모델·강도는 실행하지 않고 컴포저를 닫아도 그대로 다시 쓰이므로, 반복 실행은 단축키 하나와 문장 하나로 끝납니다.
- On Windows a prompt that does not fit the command line the agent starts with is refused before launch, with the number of characters to cut, instead of letting the launch die with no usable reason. The composer and its draft stay open, the whole command line is measured so a prompt that fits on its own is still refused when the arguments around it leave no room, and a prompt a Windows command shim would rewrite before the agent reads it is refused rather than launched as corrupted text.
  ko: Windows에서 프롬프트가 에이전트를 띄우는 명령줄에 들어가지 않으면, 이유를 알 수 없는 실패로 끝나는 대신 몇 글자를 줄여야 하는지와 함께 실행 전에 거부합니다. 컴포저와 초안은 그대로 남고, 명령줄 전체를 재므로 프롬프트만으로는 들어가도 주변 인자가 자리를 남기지 않으면 거부하며, Windows 명령 shim이 에이전트에 닿기 전에 바꿔 버릴 프롬프트도 손상된 텍스트로 실행하지 않고 거부합니다.
