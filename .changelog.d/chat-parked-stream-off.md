---
branch: chat-parked-stream-off
---

### fleet-console
#### Fixed
- Chat Mode no longer holds a live stream for a parked, minimized, or hidden panel. Only a body the user can read keeps its EventSource, so close and Resume requests are not starved behind off-screen chat subscriptions. War Room deck tiles stay subscribed because their bodies are painted.
  ko: 채팅 모드가 주차·최소화·숨김 패널에 라이브 스트림을 붙들지 않습니다. 사용자가 읽는 본문만 EventSource를 열어, 화면 밖 채팅 구독 때문에 닫기·재개 요청이 줄 서지 않습니다. War Room 덱 타일은 본문이 그려지므로 구독을 유지합니다.
