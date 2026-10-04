---
branch: fix/desktop-sidecar-verify-lock-pid
---

### fleet-desktop
#### Fixed
- Opening or quitting Fleet Console Desktop after a Console crash no longer risks terminating an unrelated program. If a Console left over from an earlier session stops responding, Desktop now reports that Fleet Console is already running instead of force-quitting it.
  ko: Console 비정상 종료 뒤 Fleet Console Desktop을 열거나 종료해도 무관한 프로그램을 종료할 위험이 사라졌습니다. 이전 세션에서 남은 Console이 응답하지 않으면 강제로 종료하는 대신 Fleet Console이 이미 실행 중이라고 알립니다.
