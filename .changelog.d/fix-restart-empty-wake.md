---
branch: fix/restart-empty-wake
---

### fleet-console
#### Fixed
- Restarting Console no longer wakes Commodores that have nothing new to handle; a wake cut off by the shutdown still reaches the Commodore on the next start.
  ko: Console을 다시 시작해도 새로 처리할 일이 없는 사령관은 깨어나지 않습니다. 종료로 끊긴 깨움은 다음 시작 때 사령관에게 그대로 전해집니다.
