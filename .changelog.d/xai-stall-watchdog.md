---
branch: xai-stall-watchdog
---

### fleet-console
#### Fixed
- End a Grok turn whose upstream went quiet mid-stream, instead of waiting on it indefinitely because the proxy keeps the connection alive without sending anything.
  ko: 스트리밍 도중 업스트림이 조용해진 Grok 턴을 끝냅니다. 프록시가 아무것도 보내지 않으면서 연결만 살려 두어도 무한정 기다리지 않습니다.
