---
branch: fix/muse-quota-latest
---

### fleet-console
#### Fixed
- A successful Muse Code usage check with no open window keeps the last reading, so Muse Code stays available to assign instead of looking unused.
  ko: 진행 중인 창이 없는 Muse Code 사용량 조회가 성공해도 마지막 값을 유지해서, 사용하지 않는 것처럼 보여 배정에서 빠지지 않습니다.
