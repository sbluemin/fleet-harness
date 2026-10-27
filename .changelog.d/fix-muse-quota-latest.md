---
branch: fix/muse-quota-latest
---

### fleet-console
#### Fixed
- Muse Code usage is read like any other provider when assigning a model, including right after a check that finds no open 5-hour window.
  ko: 진행 중인 5시간 창이 없는 조회 직후를 포함해, Muse Code 사용량이 모델을 배정할 때 다른 공급자와 같이 읽힙니다.
