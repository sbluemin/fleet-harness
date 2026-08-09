---
branch: wsl-console-home-context
---

### fleet-console

#### Fixed

- Moving to a console that runs somewhere else on this computer, such as one inside a WSL distribution or a second console you started yourself, no longer strips the way back. The host box now works out where you are standing from the console the app launched rather than from the shape of the address, so any console that is not that one unfolds your own computer's list exactly as a remote console does. The chip names the console you are standing on instead of calling it local, that console's row in the list carries its own name rather than borrowing the name of the console drawing the list, and the app tells a console where home is before the window arrives, so the way back no longer depends on which of the two gets there first.
  ko: 이 컴퓨터의 다른 곳에서 도는 콘솔 — WSL 배포판 안의 콘솔이나 직접 띄운 두 번째 콘솔 — 로 건너가도 돌아갈 길이 사라지지 않습니다. 호스트 박스는 이제 주소 모양이 아니라 앱이 띄운 콘솔을 기준으로 지금 어디에 서 있는지를 가리므로, 그 콘솔이 아닌 곳에서는 원격 콘솔에서와 똑같이 내 컴퓨터의 목록이 그대로 펼쳐집니다. 칩은 "여기"라고 말하는 대신 지금 서 있는 콘솔의 이름을 말하고, 목록 속 그 줄도 목록을 그리는 콘솔의 이름을 빌리지 않고 자기 이름을 달며, 집 주소는 창보다 먼저 그 콘솔에 도착하므로 돌아갈 길이 둘 중 무엇이 먼저 닿느냐에 좌우되지 않습니다.
