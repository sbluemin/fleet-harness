---
branch: gateway-client-identity-strip
---

### fleet-cli
#### Changed
- Stop forwarding Claude Code's own identity line and Anthropic billing header to non-Anthropic AI Gateway providers, so a Gemini, Grok, GPT, Kimi or MiniMax turn is no longer told it is Claude Code. Turns served by Anthropic itself are unaffected.
  ko: 비Anthropic AI Gateway 공급자에게 Claude Code의 정체성 문장과 Anthropic 빌링 헤더를 더 이상 보내지 않습니다. Gemini·Grok·GPT·Kimi·MiniMax 턴이 자신을 Claude Code라고 인식하지 않습니다. Anthropic이 직접 처리하는 턴은 그대로입니다.

### fleet-console
#### Changed
- Stop forwarding Claude Code's own identity line and Anthropic billing header to non-Anthropic AI Gateway providers, so a Gemini, Grok, GPT, Kimi or MiniMax turn is no longer told it is Claude Code. Turns served by Anthropic itself are unaffected.
  ko: 비Anthropic AI Gateway 공급자에게 Claude Code의 정체성 문장과 Anthropic 빌링 헤더를 더 이상 보내지 않습니다. Gemini·Grok·GPT·Kimi·MiniMax 턴이 자신을 Claude Code라고 인식하지 않습니다. Anthropic이 직접 처리하는 턴은 그대로입니다.
