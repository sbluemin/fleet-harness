---
branch: refactor/console-cli-lifecycle-contract
---

### fleet-cli
#### Fixed
- `fleet console stop` and `restart` no longer report "stopped" for a Console that did not shut down cleanly: when it had to end itself after 10 seconds, crashed, or was killed, `stop` exits with an error that says what may remain.
  ko: `fleet console stop`과 `restart`는 깨끗하게 종료되지 않은 Console을 더 이상 "stopped"로 보고하지 않습니다. 10초 뒤 스스로 종료했거나, 오류로 끝났거나, 강제로 끝난 경우 `stop`은 무엇이 남았을 수 있는지 알려 주는 오류로 끝납니다.
- `fleet console stop` now gives a stuck Console its full shutdown time before force-stopping it, and waits for a Console that is already shutting down instead of failing after a second.
  ko: `fleet console stop`은 멈춘 Console을 강제 종료하기 전에 종료 시간을 끝까지 기다리고, 이미 종료 중인 Console은 1초 만에 실패하는 대신 끝날 때까지 기다립니다.
- `fleet console start` no longer force-kills a Console that is still restoring its data when start gives up waiting; that Console now shuts itself down safely.
  ko: `fleet console start`가 기다리기를 포기할 때 아직 데이터를 복원 중인 Console을 더 이상 강제로 끝내지 않습니다. 그 Console은 이제 스스로 안전하게 종료합니다.
