---
branch: cursor-loop-latency
---

### fleet-console
#### Fixed
- Cursor models no longer waste a turn reaching for their own file reader before using the file tools your agent actually offers, so answers arrive sooner.
  ko: Cursor 모델이 에이전트가 제공한 파일 도구를 쓰기 전에 자체 파일 리더를 먼저 시도하며 한 턴을 낭비하지 않으므로, 응답이 더 빨리 도착합니다.
- Tool calls no longer lose their arguments on turns the agent sends without streaming, so those tools run on what the model actually asked for.
  ko: 에이전트가 스트리밍 없이 보내는 턴에서 도구 호출이 인자를 잃지 않으므로, 해당 도구가 모델이 실제로 요청한 값으로 실행됩니다.
- A gateway model no longer fails the request when the caller sends its system prompt as plain text instead of a list of blocks.
  ko: 호출자가 시스템 프롬프트를 블록 목록이 아닌 일반 텍스트로 보내도 게이트웨이 모델이 요청을 실패시키지 않습니다.
