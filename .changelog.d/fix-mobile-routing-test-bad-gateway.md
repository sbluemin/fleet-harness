---
branch: fix/mobile-routing-test-bad-gateway
---

### fleet-mobile
#### Fixed
- Routing tests and other slow requests no longer fail with a "Bad gateway" error when the decision takes longer than a few seconds.
  ko: 라우팅 테스트처럼 판단에 몇 초 이상 걸리는 요청이 더 이상 "Bad gateway" 오류로 실패하지 않습니다.
