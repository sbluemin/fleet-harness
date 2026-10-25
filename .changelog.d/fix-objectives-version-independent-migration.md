---
branch: fix/objectives-version-independent-migration
---

### fleet-console
#### Fixed
- Updating Console no longer locks every board when one commodore's index cannot be read. That index stays unchanged, and saving the other boards still persists.
  ko: 한 사령관의 색인을 읽지 못해도 Console 업데이트가 모든 보드를 잠그지 않습니다. 그 색인은 그대로 남고, 다른 보드의 저장은 계속 디스크에 남습니다.
