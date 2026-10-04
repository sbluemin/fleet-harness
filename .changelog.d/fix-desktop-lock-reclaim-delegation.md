---
branch: fix/desktop-lock-reclaim-delegation
---

### fleet-desktop
#### Fixed
- When Console's lock file is unreadable, or another start holds it, Desktop now explains what is holding it and how to clear it safely instead of showing a generic startup error, and it leaves the lock untouched.
  ko: Console의 lock 파일을 읽을 수 없거나 다른 시작 과정이 lock을 쥐고 있으면, 이제 Desktop이 일반 시작 오류 대신 무엇이 lock을 쥐고 있는지와 안전하게 정리하는 방법을 안내하고 lock은 그대로 둡니다.
- A Desktop launch that fails while Console is starting no longer leaves that Console running in the background.
  ko: Console이 시작되는 도중 Desktop 실행이 실패해도 그 Console이 백그라운드에 남아 실행되지 않습니다.

### fleet-console
#### Fixed
- When an update cannot start the new Console because its lock is held, the update now fails within seconds and its log records what holds the lock, instead of waiting a minute without a reason.
  ko: 업데이트 후 새 Console이 lock을 얻지 못해 시작하지 못하면, 이제 1분을 기다리지 않고 몇 초 안에 실패하며 무엇이 lock을 쥐고 있는지가 업데이트 로그에 남습니다.
