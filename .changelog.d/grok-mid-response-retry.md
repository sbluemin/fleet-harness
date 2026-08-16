---
branch: grok-mid-response-retry
---

### fleet-cli
#### Fixed
- Retry transient Grok server and socket failures before any caller-visible output instead of ending the model turn with an incomplete-response API error.
  ko: 호출자에게 출력이 보이기 전 발생한 Grok 서버 및 소켓 일시 오류를 재시도하여 모델 턴이 불완전 응답 API 오류로 끝나지 않게 했습니다.

### fleet-console
#### Fixed
- Retry transient Grok server and socket failures before any caller-visible output instead of ending the model turn with an incomplete-response API error.
  ko: 호출자에게 출력이 보이기 전 발생한 Grok 서버 및 소켓 일시 오류를 재시도하여 모델 턴이 불완전 응답 API 오류로 끝나지 않게 했습니다.
