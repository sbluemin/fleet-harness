---
branch: fix/objectives-version-independent-migration
---

### fleet-console
#### Fixed
- Updating Console no longer locks a board or drops an objective already copied when startup is interrupted. An objective whose index cannot be read stays hidden instead of reappearing as active, and a newly added objective remains after restart.
  ko: 기동이 중간에 끊겨도 이미 복사된 목표가 다음 시작에서 빠지거나 보드 전체가 잠기지 않습니다. 색인을 읽지 못한 목표는 활성으로 되살아나지 않고 숨겨 두며, 새로 추가한 목표는 재시작 후에도 남습니다.
