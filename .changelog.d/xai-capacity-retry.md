---
branch: xai-capacity-retry
---

### fleet-cli
#### Fixed
- Retry a Grok turn that xAI refused for capacity, and name the refusal an overload when the retry is refused too. xAI announces it with an empty error type and code, so the gateway read it as a plain API error, never retried it, and ended the turn on a message that only asked you to try again in a few minutes.
  ko: xAI가 용량 부족으로 거절한 Grok 턴을 재시도하고, 재시도까지 거절당하면 과부하로 알립니다. xAI가 오류 종류와 코드를 비워 보내는 탓에 게이트웨이가 일반 API 오류로 읽어 재시도 없이, 잠시 뒤 다시 시도하라는 안내만 남긴 채 턴을 끝냈습니다.

### fleet-console
#### Fixed
- Retry a Grok turn that xAI refused for capacity, and name the refusal an overload when the retry is refused too. xAI announces it with an empty error type and code, so the gateway read it as a plain API error, never retried it, and ended the turn on a message that only asked you to try again in a few minutes.
  ko: xAI가 용량 부족으로 거절한 Grok 턴을 재시도하고, 재시도까지 거절당하면 과부하로 알립니다. xAI가 오류 종류와 코드를 비워 보내는 탓에 게이트웨이가 일반 API 오류로 읽어 재시도 없이, 잠시 뒤 다시 시도하라는 안내만 남긴 채 턴을 끝냈습니다.
