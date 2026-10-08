---
branch: feat/commodore-actions-only
---

### fleet-console
#### Changed
- The Commodore now leaves an objective's plan to its Commander: it creates objectives from a title and brief, edits only those, and steers with short remarks while missions, success criteria and members come from the Commander's plan.
  ko: 사령관은 이제 목표의 구상을 지휘관에게 맡깁니다. 목표는 제목과 브리핑으로만 만들고 그 둘만 고치며, 짧은 첨언으로 방향을 잡고, 임무·달성 기준·구성원은 지휘관의 구상에서 나옵니다.
- Console Use agents and the Commodore now share one set of Objectives tools: neither edits missions or success criteria directly, both can tidy objectives and read session transcripts while an objective waits or has no session working, and commencing first reviews the AI Gateway routing it will launch members with.
  ko: Console Use 에이전트와 사령관이 이제 같은 Objectives 도구를 씁니다. 둘 다 임무와 달성 기준을 직접 고치지 않고, 목표를 정리하며, 목표가 기다리거나 일하는 세션이 없을 때 세션 기록을 읽고, 개시 전에는 구성원을 띄울 AI Gateway 라우팅 결과를 먼저 확인합니다.
- Console Use tool descriptions are much shorter, so every session that loads them spends less context.
  ko: Console Use 도구 설명이 크게 짧아져 이를 싣는 모든 세션이 쓰는 컨텍스트가 줄었습니다.

#### Added
- Commanders can note a proposed model for each member they plan, and AI Gateway routing takes it into account when it assigns the member's model.
  ko: 지휘관이 구성원을 편성할 때 구성원마다 제안 모델을 적을 수 있고, AI Gateway 라우팅이 구성원의 모델을 정할 때 이를 참고합니다.
