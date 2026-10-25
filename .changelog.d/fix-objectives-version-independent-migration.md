---
branch: fix/objectives-version-independent-migration
---

### fleet-console
#### Fixed
- Updating straight from an older Console no longer leaves a commodore's objective board stuck in "recovery required": existing objectives, evidence, and groups move over on the next start, and an unreadable objective or index now sets aside only the affected items instead of blocking the whole board.
  ko: 이전 버전 Console에서 바로 업데이트해도 사령관의 목표 보드가 "recovery required"에 갇히지 않습니다. 기존 목표, 증거, 그룹은 다음 기동 때 옮겨지고, 읽을 수 없는 목표나 색인이 있으면 보드 전체를 막지 않고 해당 항목만 따로 보류합니다.
