---
branch: fix-console-startup-readiness
---

### fleet-console
#### Fixed
- Let slow Windows starts reach readiness and clean up failed startup processes without leaving a background Console behind.
  ko: 느린 Windows 시작이 준비 완료까지 기다리며, 시작 실패 시 뒤에 Console 프로세스를 남기지 않고 정리합니다.
