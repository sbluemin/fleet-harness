---
branch: feat/wsl-console-fonts
---

### fleet-console
#### Added
- Choose fonts installed on the device you are viewing the Console from, such as Windows fonts for a Console running in WSL, with Load this device's fonts in the font menu. The list stays on that screen and is never sent or saved.
  ko: 글꼴 메뉴의 "이 기기의 글꼴 불러오기"로 Console을 보고 있는 기기에 설치된 글꼴을 고를 수 있습니다. 예를 들어 WSL에서 실행 중인 Console에서도 Windows 글꼴을 쓸 수 있습니다. 목록은 그 화면에만 머물며 전송하거나 저장하지 않습니다.

#### Fixed
- Font menus now say the listed fonts are installed on the Console host and group fonts this device cannot draw separately, instead of calling them installed on this machine.
  ko: 글꼴 메뉴가 목록의 글꼴을 "이 기기에 설치됨" 대신 Console 호스트에 설치된 글꼴로 표시하고, 이 기기에서 그릴 수 없는 글꼴은 따로 묶어 보여 줍니다.
- On Linux and WSL, monospaced fonts such as Consolas now appear in the code font menu.
  ko: Linux와 WSL에서 Consolas 같은 고정폭 글꼴이 코드 글꼴 메뉴에 나타납니다.
