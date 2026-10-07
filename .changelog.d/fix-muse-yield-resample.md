---
branch: fix/muse-yield-resample
---

### fleet-console
#### Fixed
- Muse no longer calls another tool right after it starts waiting on a background job or a scheduled wakeup, so that wait does not turn into a second run.
  ko: Muse가 백그라운드 작업이나 예약 깨우기를 기다리기 시작한 직후에 다른 도구를 다시 부르지 않아, 그 대기가 한 번 더 실행으로 이어지지 않습니다.
