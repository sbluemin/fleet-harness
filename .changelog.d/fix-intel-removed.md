---
branch: fix/intel-removed
---

### fleet-console
#### Fixed
- Deleting Commodore intel no longer shows up as new intel: an item removed before the Commodore saw it no longer wakes it, and removing one it already knew is logged as intel removed.
  ko: 사령관 정보를 지워도 더 이상 '새 정보'로 뜨지 않습니다. 사령관이 보기 전에 지운 항목으로는 깨우지 않고, 이미 알던 항목을 지우면 '정보 삭제'로 기록됩니다.
