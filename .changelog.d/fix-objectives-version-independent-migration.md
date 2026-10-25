---
branch: fix/objectives-version-independent-migration
---

### fleet-console
#### Fixed
- Updating Console no longer locks a board or drops an objective already copied when startup is interrupted. A temporary failure while reading an index leaves that index unchanged, and an index that cannot be parsed stays hidden instead of reappearing as active.
  ko: 기동이 중간에 끊겨도 이미 복사된 목표가 다음 시작에서 빠지거나 보드 전체가 잠기지 않습니다. 색인을 읽다 잠시 실패해도 그 색인은 그대로 남고, 해석할 수 없는 색인은 활성으로 되살아나지 않고 숨겨 둡니다.
