---
branch: update-continuity
---

### fleet-console

#### Changed

- Updating now keeps the screen you were on: the console comes back on the same address, the open tab reconnects itself, and no second window is opened unless the old address could not be reclaimed.
  ko: 업데이트해도 보고 있던 화면을 잃지 않습니다. Console이 같은 주소로 돌아오고 열려 있던 탭이 스스로 다시 연결되며, 옛 주소를 되찾지 못한 경우에만 새 창이 열립니다.
- An update in progress reads as progress instead of a connection error: a curtain names the step the console is in and says the screen will come back, and the result is reported when it does.
  ko: 업데이트 중에는 연결 오류 대신 진행 상태가 보입니다. 어느 단계인지와 화면이 돌아온다는 사실을 알리고, 돌아온 뒤 결과를 보고합니다.
- The update mark moved from the settings button to the help button, where the update action lives, and the menu row now names the version it would install.
  ko: 업데이트 표식이 설정 버튼에서 실행 위치인 도움말 버튼으로 옮겨졌고, 메뉴 항목이 설치할 버전을 함께 표시합니다.
- Updating from a remote session now asks for confirmation first, because it restarts the console on someone else's machine.
  ko: 원격 세션에서의 업데이트는 먼저 확인을 요구합니다. 다른 기계의 Console을 다시 시작하는 일이기 때문입니다.

#### Fixed

- Update no longer claims to be done while it is still installing, and a failed update now says so with its reason instead of leaving the console silent.
  ko: 설치 중인데 완료했다고 말하지 않으며, 실패한 업데이트는 침묵 대신 사유와 함께 실패를 알립니다.
- A remote screen recovers by itself after the console restarts, instead of retrying an expired session forever.
  ko: Console이 다시 시작된 뒤 원격 화면이 스스로 복구됩니다. 만료된 세션으로 영원히 재시도하지 않습니다.

### fleet-desktop

#### Changed

- Update from inside the console now works on Desktop: the shell picks up the request and performs it with its own restart, instead of the console offering a control that could not act.
  ko: Console 안에서의 업데이트가 Desktop에서도 동작합니다. 셸이 요청을 받아 자기 재시작으로 수행하며, 동작하지 않는 컨트롤을 내놓지 않습니다.

#### Fixed

- A window whose remote session ended is now told to open that host again, instead of being sent to ask for an access link it does not need.
  ko: 원격 세션이 끝난 창에는 필요 없는 액세스 링크를 구하라는 대신, 해당 호스트를 다시 열라고 안내합니다.
