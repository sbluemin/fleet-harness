---
branch: feat/gemini-provider
---

### fleet-console
#### Added
- Use Gemini 4 Argon, Carbon, and Hydrogen with your own Google AI Studio API key, added under Settings > AI Gateway.
  ko: 설정 > AI Gateway에서 Google AI Studio API 키를 추가하면 Gemini 4 Argon·Carbon·Hydrogen을 쓸 수 있습니다.
- Each Gemini model runs on the half-price Flex tier by default and switches to Standard for that request when Flex is at capacity; pick Standard per model in the routing pool or the session model picker.
  ko: Gemini 모델은 기본으로 반값인 Flex 등급으로 요청하고, Flex 용량이 없으면 그 요청만 Standard로 다시 보냅니다. 라우팅 풀이나 세션 모델 선택기에서 모델별로 Standard를 고를 수 있습니다.
- Quota shows this month's Gemini spend as Fleet counts it from token usage, with a progress bar once you set a monthly budget on the Gemini card, and says when Gemini stops requests because your balance ran out or a limit was hit.
  ko: Quota가 플릿이 토큰 사용량으로 센 이번 달 Gemini 지출을 보여 주고, Gemini 카드에서 월 예산을 넣으면 진행 막대가 섭니다. 잔액 소진이나 한도 초과로 요청이 막히면 그 사유도 알려 줍니다.
