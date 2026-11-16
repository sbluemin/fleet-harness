---
branch: fix/console-lock-boot-session
---

### fleet-console
#### Fixed
- After the computer restarts, Fleet Console starts again even when a leftover lock still names a process id that another program is now using.
  ko: 컴퓨터를 다시 시작한 뒤, 남아 있는 잠금이 지금 다른 프로그램이 쓰는 프로세스 번호를 가리켜도 Fleet Console이 다시 시작됩니다.

### fleet-cli
#### Added
- `fleet console start --recover` clears a broken or stuck Console lock after checking that no Console is running and no update is in progress, then starts.
  ko: `fleet console start --recover`는 Console이 실행 중이 아니고 업데이트도 진행 중이 아닌지 확인한 다음, 깨지거나 멈춘 Console 잠금을 지우고 시작합니다.

### fleet-desktop
#### Added
- When Desktop cannot start because a Console lock is in the way, the dialog can clear that lock and start again after checking that no Console is running and no update is in progress.
  ko: Console 잠금 때문에 Desktop이 시작하지 못하면, 대화상자에서 Console이 실행 중이 아니고 업데이트도 진행 중이 아닌지 확인한 다음 잠금을 지우고 다시 시작할 수 있습니다.
