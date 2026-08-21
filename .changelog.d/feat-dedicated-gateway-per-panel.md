---
branch: feat/dedicated-gateway-per-panel
---

### fleet-console
#### Added
- Give each panel its own AI Gateway from Settings, off by default so panels keep sharing one. A panel launched with it on gets its own upstream in-flight ceiling, Cursor adapter, and HTTP/2 sessions; it does not add allowance, since panels still share one credential and one rate limit per provider. Running panels keep the gateway they launched with, and a panel's gateway is released when its Operation is deleted.
  ko: 설정에서 패널마다 AI Gateway를 따로 띄울 수 있습니다. 기본값은 Off이며 이때는 지금처럼 하나를 공유합니다. 켠 뒤 실행한 패널은 업스트림 동시 실행 상한과 Cursor 어댑터, HTTP/2 세션을 자기 것으로 갖습니다. 할당량이 늘지는 않습니다 — 공급자별 자격 증명과 요청 제한은 여전히 하나입니다. 실행 중인 패널은 실행 당시의 게이트웨이를 그대로 쓰고, 패널의 게이트웨이는 그 Operation이 삭제될 때 회수됩니다.
