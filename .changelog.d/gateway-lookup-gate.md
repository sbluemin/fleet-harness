---
branch: gateway-lookup-gate
---

### fleet-cli
#### Changed
- A delegation is now refused until the session has actually called `gateway_models`. Naming a `fleet:*` identity is no longer enough on its own: the roster is resolved at call time, so a name carried in from memory or from another session is refused with the lookup instruction instead of dispatching against a roster nobody read. Built-in agent types still need no lookup, and a session whose transcript cannot be read is not blocked.
  ko: 이제 세션이 `gateway_models`를 실제로 호출하기 전까지는 위임이 거부됩니다. `fleet:*` 정체성을 적어 넣는 것만으로는 부족합니다 — 로스터는 호출 시점에 결정되므로, 기억이나 다른 세션에서 가져온 이름은 아무도 읽지 않은 로스터로 디스패치되는 대신 조회 안내와 함께 거부됩니다. 내장 에이전트 타입은 여전히 조회가 필요 없고, 트랜스크립트를 읽을 수 없는 세션은 차단되지 않습니다.
