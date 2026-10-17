---
branch: fix/desktop-remote-expired-hang
---

### fleet-desktop
#### Fixed
- When a remote Console ends your session, Fleet Desktop now returns to your own Console and shows the error, instead of freezing until you force it to quit.
  ko: 원격 Console이 세션을 끝내면 Fleet Desktop이 강제 종료해야 할 만큼 멈추지 않고, 내 Console로 돌아와 오류를 보여 줍니다.
