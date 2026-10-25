---
branch: fix/objectives-version-independent-migration
---

### fleet-console
#### Fixed
- Updating Console no longer locks every board when one commodore's index cannot be read, and a board that becomes readable later is not deleted by the next save.
  ko: 한 사령관의 색인을 읽지 못해도 Console 업데이트가 모든 보드를 잠그지 않습니다. 나중에 다시 읽힌 보드도 다음 저장에서 지워지지 않습니다.
