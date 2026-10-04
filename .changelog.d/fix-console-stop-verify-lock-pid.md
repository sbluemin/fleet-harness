---
branch: fix/console-stop-verify-lock-pid
---

### fleet-cli
#### Fixed
- `fleet console`, `fleet console stop`, and `fleet console restart` no longer risk terminating an unrelated program after a Console crash; when a Console stops responding, they now tell you which process to stop instead of force-killing it.
  ko: `fleet console`, `fleet console stop`, `fleet console restart`가 Console 비정상 종료 뒤 무관한 프로그램을 종료할 위험이 사라졌습니다. Console이 응답하지 않으면 강제로 종료하는 대신 어떤 프로세스를 멈춰야 하는지 알려 줍니다.
