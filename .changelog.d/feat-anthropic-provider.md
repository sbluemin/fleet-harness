---
branch: feat/anthropic-provider
---

### fleet-console
#### Added
- Use Claude Opus, Sonnet, and Haiku with your own Anthropic API key, including the monthly API credit that comes with a Claude subscription, added under Settings > AI Gateway. They are listed separately from your subscription Claude models and marked Anthropic. Anthropic applies the credit to Console agent sessions, not to the interactive terminal.
  ko: 설정 > AI Gateway에서 Anthropic API 키를 추가하면 Claude Opus·Sonnet·Haiku를 API 크레딧으로 쓸 수 있습니다. 구독 Claude 모델과 별도 항목으로, Anthropic으로 표시됩니다. Anthropic은 이 크레딧을 Console 에이전트 세션에만 적용하며 대화형 터미널에는 적용하지 않습니다.
- Quota shows this week's Anthropic API spend as Fleet counts it from response usage, with a weekly progress bar once you set a budget, says why Anthropic stopped a request, and shows the API key's request and token limits as their last response reported them.
  ko: Quota가 플릿이 응답 사용량으로 센 이번 주 Anthropic API 지출을 보여 주고, 주 예산을 넣으면 주간 진행 막대가 섭니다. 요청이 거절되면 사유를 알려 주고, API 키의 요청·토큰 한도도 마지막 응답이 알려 준 값으로 표시합니다.
