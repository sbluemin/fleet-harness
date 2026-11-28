---
branch: fix/mobile-reconnect-cap
---

### fleet-console
#### Fixed
- After a long disconnect, Console reconnects on its own within about 10 seconds of the host coming back, instead of waiting up to 30 seconds or needing Reconnect.
  ko: 연결이 오래 끊겼다가 호스트가 돌아오면, 최대 30초를 기다리거나 다시 연결을 누를 필요 없이 10초 안팎에 스스로 다시 연결됩니다.
