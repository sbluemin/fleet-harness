---
branch: fix/muse-yield-resample
---

### fleet-console
#### Fixed
- Muse turns that start a background job or a scheduled wakeup and stop to wait now actually wait, instead of being pushed to continue and poll or start the same job again.
  ko: Muse가 백그라운드 작업이나 예약 깨우기를 걸고 기다리며 턴을 끝내면, 이제 계속하라는 재촉을 받지 않아 폴링하거나 같은 작업을 한 번 더 실행하지 않고 그대로 기다립니다.
