---
branch: feat/gateway-candidates-direct-model
---

### fleet-console
#### Changed
- Commodores now choose each Commander's model, and Commanders each member's model, from AI Gateway candidates: the models you turned on, ordered by remaining quota, without providers that are close to their limit. A member you add without a model waits until its Commander picks one.
  ko: 이제 사령관은 지휘관 모델을, 지휘관은 구성원 모델을 AI Gateway 후보에서 직접 고릅니다. 후보는 켠 모델을 남은 쿼터 순으로 정렬하고, 한도에 가까운 공급자는 뺀 목록입니다. 모델 없이 추가한 구성원은 지휘관이 모델을 고를 때까지 기다립니다.
- AI Gateway settings show the candidate list Commodores and Commanders receive, including models left out of it, in place of the routing settings and routing test.
  ko: AI Gateway 설정에서 라우팅 설정과 라우팅 테스트 대신, 사령관·지휘관이 받는 후보 목록과 후보에서 빠진 모델을 보여 줍니다.

#### Removed
- Removed AI routing through Jev or a routing model. Subagents and Workflow stages now get their model from a fixed quota rule; TypeSafe sign-in remains available.
  ko: Jev나 라우팅 모델을 통한 AI 라우팅을 없앴습니다. 하위 에이전트와 Workflow 단계는 이제 정해진 쿼터 규칙으로 모델을 받으며, TypeSafe 로그인은 그대로 쓸 수 있습니다.
