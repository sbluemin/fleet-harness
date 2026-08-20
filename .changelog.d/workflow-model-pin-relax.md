---
branch: workflow-model-pin-relax
---

### fleet-cli
#### Changed
- A workflow stage no longer has to name a gateway model. Stages that name none run on the session's own model, and a stage may pin an identity through `agentType` again; only a model value that would kill the run at dispatch is still refused. Naming a gateway identity remains required for `Agent` delegation.
  ko: 워크플로 스테이지가 더 이상 게이트웨이 모델을 반드시 지정하지 않아도 됩니다. 지정하지 않은 스테이지는 세션 자신의 모델로 돌고, `agentType`으로 정체성을 핀하는 것도 다시 허용되며, 디스패치 즉시 실행을 죽이는 모델 값만 여전히 거부됩니다. `Agent` 위임은 그대로 게이트웨이 정체성 지정이 필요합니다.
