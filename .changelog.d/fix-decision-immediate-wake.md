---
branch: fix/decision-immediate-wake
---

### fleet-console
#### Fixed
- Decision requests now wake the Commodore without waiting for the Commander's turn to finish, and do not wake it again when the unchanged objective's group goes idle.
  ko: 결정 요청이 생기면 지휘관의 턴이 끝나기를 기다리지 않고 사령관을 깨우며, 목표에 변화가 없다면 이후 그룹이 대기 중이 되어도 다시 깨우지 않습니다.
