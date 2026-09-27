---
branch: mcp-result-delivery-failure
---

### fleet-console
#### Fixed
- An agent's Console tool call no longer hangs when its result cannot be returned; the agent is told the tool may already have run.
  ko: Console 도구 결과를 돌려주지 못해도 에이전트의 호출이 멈추지 않고, 도구가 이미 실행됐을 수 있다는 오류를 받습니다.
