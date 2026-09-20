---
branch: console-owns-routing-decision
---

### fleet-console
#### Changed
- Delegated runs now spread across your providers instead of all landing on one, and skip a provider whose allowance is nearly spent.
  ko: 위임 작업이 한 공급자에 몰리지 않고 여러 공급자로 나뉘며, 잔여 허용량이 거의 없는 공급자는 건너뜁니다.

#### Fixed
- Delegated runs that named Fleet's own execution agent no longer fall back to the session model instead of a gateway model.
  ko: Fleet 실행 에이전트를 이름으로 지정한 위임 작업이 게이트웨이 모델 대신 세션 모델로 돌던 문제를 고쳤습니다.
- The routing pane and the line under the prompt read correctly again: no doubled `fleet:` prefix, and a Korean run name no longer pushes the elapsed time onto a line of its own.
  ko: 라우팅 판과 프롬프트 아래 줄의 표기를 바로잡았습니다. `fleet:` 접두사가 겹치지 않고, 한글 작업 이름이 소요 시간을 다른 줄로 밀어내지 않습니다.

#### Removed
- Fleet no longer adds routing instructions to an agent session or serves the routing guides and model roster it read them from; Fleet picks each delegated run's model on its own.
  ko: Fleet이 에이전트 세션에 라우팅 지침을 넣거나 그 근거가 되던 라우팅 가이드·모델 로스터를 제공하지 않습니다. 위임 작업의 모델은 Fleet이 알아서 고릅니다.
