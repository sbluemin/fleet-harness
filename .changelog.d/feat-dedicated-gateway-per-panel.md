---
branch: feat/dedicated-gateway-per-panel
---

### fleet-console
#### Added
- Give each panel its own AI Gateway from Settings, off by default so panels keep sharing one. A panel launched with it on runs its own gateway process on its own port, so its upstream connections, provider adapter state, memory, and crash domain are separate from every other panel. It does not add allowance: settings, credentials, and each provider's own rate limit stay shared, and each gateway costs about 42 MiB and a tenth of a second to start. Up to eight panels get their own, a running panel keeps the gateway it launched with, and a panel's gateway shuts down when its Operation is deleted or the Console exits.
  ko: 설정에서 패널마다 AI Gateway를 따로 띄울 수 있습니다. 기본값은 Off이며 이때는 지금처럼 하나를 공유합니다. 켠 뒤 실행한 패널은 자기 포트로 게이트웨이 프로세스를 띄워, 업스트림 커넥션과 공급자 어댑터 상태, 메모리, 크래시 도메인이 다른 패널과 분리됩니다. 할당량이 늘지는 않습니다 — 설정과 자격 증명, 공급자 쪽 요청 제한은 그대로 공유되며, 게이트웨이 하나당 약 42 MiB와 0.1초 남짓의 기동 시간이 듭니다. 최대 8개까지 전용을 받고, 실행 중인 패널은 실행 당시의 게이트웨이를 그대로 쓰며, 패널의 게이트웨이는 그 Operation이 삭제되거나 Console이 종료될 때 내려갑니다.
