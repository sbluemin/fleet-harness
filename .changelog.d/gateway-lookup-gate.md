---
branch: gateway-lookup-gate
---

### fleet-cli
#### Breaking Changes
- Every `Workflow` stage must name a gateway model again. A stage that pins none is refused before the run instead of falling back to the session model, and `agentType` is refused in a script rather than accepted as a stage's other pin. Delegation is judged from the call payload alone: no roster lookup has to land first, so naming a `fleet:*` identity is enough to dispatch.
  ko: 모든 `Workflow` 스테이지가 다시 게이트웨이 모델을 지정해야 합니다. 아무것도 핀하지 않은 스테이지는 세션 모델로 넘어가지 않고 실행 전에 거부되며, `agentType`은 스테이지의 또 다른 핀으로 인정되지 않고 스크립트에서 거부됩니다. 위임은 호출 페이로드만으로 판정되므로 로스터 조회가 선행될 필요 없이 `fleet:*` 정체성을 적는 것만으로 디스패치됩니다.
