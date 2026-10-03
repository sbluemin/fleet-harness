---
branch: gateway-finish-reason-max-tokens
---

### fleet-console
#### Fixed
- OpenCode Go and Antigravity model answers that hit the output limit now end as cut off, so Claude Code can continue them, and answers stopped by a safety filter no longer look finished. Antigravity answers that stop for any other reason, such as a malformed tool call, now end with an error naming that reason instead of looking finished.
  ko: OpenCode Go와 Antigravity 모델의 답이 출력 상한에서 잘리면 이제 잘린 것으로 끝나 Claude Code가 이어서 생성할 수 있고, 안전 필터로 멈춘 답도 더 이상 끝난 답처럼 보이지 않습니다. Antigravity 답이 잘못된 도구 호출 같은 다른 이유로 멈추면 끝난 답처럼 보이는 대신 그 이유를 밝힌 오류로 끝납니다.
