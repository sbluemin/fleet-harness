---
branch: gateway-f10-incomplete-max-tokens
---

### fleet-console
#### Fixed
- Muse turns stop less often right after saying what they will do next, without actually doing it.
  ko: Muse 턴이 다음에 할 일을 말만 하고 실제로 하지 않은 채 멈추는 일이 줄었습니다.
- Gateway model answers that hit the output limit are no longer treated as finished, so Claude Code can continue them instead of keeping a cut-off reply.
  ko: 출력 한도에 닿은 게이트웨이 모델 답변을 더 이상 완료로 처리하지 않으므로, Claude Code가 잘린 답변에서 멈추지 않고 이어서 생성할 수 있습니다.
- Interrupting a session or losing the connection now also stops its gateway model request, so it no longer keeps using your subscription in the background.
  ko: 세션을 중단하거나 연결이 끊기면 게이트웨이 모델 요청도 함께 멈춰, 뒤에서 구독 사용량을 계속 소모하지 않습니다.
