---
branch: xai-loop-optimization
---

### fleet-console
#### Fixed
- Keep a Grok turn whose tool call arrived complete but whose stream stopped before its closing frame, instead of ending the turn with a mid-response server error.
  ko: 도구 호출은 온전히 도착했는데 스트림이 마지막 프레임 전에 멈춘 Grok 턴을 응답 중단 오류로 끝내지 않고 살립니다.
