---
branch: console-rejection-policy
---

### fleet-console
#### Fixed
- Keep other Console sessions running when one background request fails, while recording the failure for diagnosis.
  ko: 백그라운드 요청 하나가 실패해도 다른 Console 세션은 계속 실행하고, 진단을 위해 실패 내용을 기록합니다.
