---
branch: gateway-strip-usage-limit-directives
---

### fleet-console
#### Fixed
- Keep Claude Code's usage-limit wrap-up directive out of every request the AI gateway forwards, so work running on another provider is no longer told to cut itself short because the Claude subscription is near its limit.
  ko: Claude Code가 한도 임박 시 대화에 끼워 넣는 마무리 지시를 AI 게이트웨이가 더 이상 전달하지 않습니다. 다른 공급자로 실행 중인 작업이 Claude 구독 사정 때문에 축소되지 않습니다.
