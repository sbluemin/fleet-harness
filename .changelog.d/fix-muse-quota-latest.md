---
branch: fix/muse-quota-latest
---

### fleet-console
#### Fixed
- A successful Muse Code usage check with no open window records the 5-hour session as unused and keeps a weekly reading that has not reset, so Muse Code stays available to assign.
  ko: 진행 중인 창이 없는 Muse Code 사용량 조회가 성공하면 5시간 세션을 미사용으로 기록하고, 리셋 전인 주간 값은 그대로 두어 배정에서 빠지지 않습니다.
