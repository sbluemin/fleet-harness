---
branch: feat/wsl-console-fonts
---

### fleet-console
#### Added
- Choose fonts installed on the device you are viewing the Console from, such as Windows fonts for a Console running in WSL. In Chrome or Edge, allow it once with Load this device's fonts in the font menu, and the list loads by itself afterward. The list stays on that screen and is never sent or saved.
  ko: Console을 보고 있는 기기에 설치된 글꼴을 고를 수 있습니다. 예를 들어 WSL에서 실행 중인 Console에서도 Windows 글꼴을 쓸 수 있습니다. Chrome이나 Edge에서는 글꼴 메뉴의 "이 기기의 글꼴 불러오기"로 한 번 허용하면 이후에는 목록이 자동으로 불러와집니다. 목록은 그 화면에만 머물며 전송하거나 저장하지 않습니다.

#### Fixed
- Font menus no longer lead with fonts marked Unavailable: fonts this screen cannot draw are folded into one summary line, and the rest are labeled as installed on the Console host instead of on this machine.
  ko: 글꼴 메뉴가 더 이상 "사용 불가" 글꼴부터 보여 주지 않습니다. 이 화면에서 그릴 수 없는 글꼴은 요약 한 줄로 접히고, 나머지는 "이 기기에 설치됨" 대신 Console 호스트에 설치된 글꼴로 표시됩니다.
- Monospaced fonts such as Consolas now appear in the code font menu for a Console running on Windows, Linux, or WSL.
  ko: Windows, Linux, WSL에서 실행 중인 Console의 코드 글꼴 메뉴에 Consolas 같은 고정폭 글꼴이 나타납니다.

### fleet-desktop
#### Added
- Font menus in Fleet Desktop list this computer's fonts: right away for a Console on the same computer, including one in WSL, and after you allow it in a dialog for a Console on another computer. Your answer lasts until Fleet Desktop quits, and earlier Desktop versions keep the Console host's list.
  ko: Fleet Desktop의 글꼴 메뉴에 이 컴퓨터의 글꼴이 나옵니다. 같은 컴퓨터(WSL 포함)의 Console에서는 바로, 다른 컴퓨터의 Console에서는 확인창에서 허용한 뒤에 나옵니다. 답은 Fleet Desktop을 종료할 때까지 유지되며, 이전 버전의 Desktop에서는 Console 호스트의 목록을 그대로 보여 줍니다.
