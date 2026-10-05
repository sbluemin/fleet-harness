---
branch: fix/update-preflight-barrier
---

### fleet-console
#### Fixed
- Keep Console running when an update cannot finish its preparation, and show the failure without waiting for a restart.
  ko: 업데이트 준비를 마치지 못하면 Console을 종료하지 않고 재시작을 기다리는 대신 실패 원인을 바로 보여 줍니다.
