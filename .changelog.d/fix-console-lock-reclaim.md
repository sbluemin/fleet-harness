---
branch: fix/console-lock-reclaim
---

### fleet-cli
#### Fixed
- `fleet console start` no longer starts a second Console on a data folder whose Console is still running, and starting Console directly after a killed or crashed Console no longer fails until you run `stop` first. Console now clears a leftover lock only when its process has exited.
  ko: `fleet console start`가 이미 Console이 실행 중인 데이터 폴더에 Console을 하나 더 띄우지 않습니다. 강제 종료되거나 비정상 종료된 Console 뒤에 Console을 직접 띄울 때도 먼저 `stop`을 실행하지 않아도 됩니다. 이제 Console은 남은 lock의 프로세스가 종료됐을 때만 그 lock을 지웁니다.
- When Console cannot tell whether a lock's owner is still running, such as an empty or unreadable lock or a pid now used by another process, `start` and `stop` exit with an error instead of deleting it. The error names the lock file and explains how to confirm that nothing is using that data folder before you remove it.
  ko: 비어 있거나 읽을 수 없는 lock, 또는 pid가 다른 프로세스로 바뀐 lock처럼 lock의 소유자가 실행 중인지 확인할 수 없으면 `start`와 `stop`이 lock을 지우지 않고 오류로 끝납니다. 오류에는 lock 파일 경로와, 지우기 전에 그 데이터 폴더를 쓰는 작업이 없는지 확인하는 방법이 나옵니다.
