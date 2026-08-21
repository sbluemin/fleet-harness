---
branch: gateway-usage-stream
---

### fleet-console
#### Fixed
- Report a running turn's token count for gateway models whose provider withholds usage until the turn ends, instead of showing zero for the whole run.
  ko: 턴이 끝나야 사용량을 주는 공급자의 게이트웨이 모델도 실행 중 토큰 수를 보여줍니다. 더 이상 실행 내내 0으로 남지 않습니다.
