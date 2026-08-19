---
branch: sysprompt-removal
---

### fleet-cli
#### Changed
- Gateway sessions no longer carry a Fleet system prompt or Fleet skills. Each turn states the pin contract instead, and a delegation that names no gateway identity is refused with instructions rather than quietly running on the session's own model.
  ko: 게이트웨이 세션이 Fleet 시스템 프롬프트와 Fleet 스킬을 더 이상 싣지 않습니다. 대신 매 턴 핀 규약을 알리고, 게이트웨이 정체성을 지정하지 않은 위임은 세션 자신의 모델로 조용히 실행되는 대신 방법을 안내하며 거절합니다.

### fleet-console
#### Removed
- The Fleet system prompt mode setting is gone. Gateway sessions and Chat Mode no longer receive a Fleet system prompt, so there is nothing left to choose between.
  ko: Fleet 시스템 프롬프트 모드 설정이 사라졌습니다. 게이트웨이 세션과 Chat Mode가 Fleet 시스템 프롬프트를 더 이상 받지 않아 고를 대상이 남지 않았습니다.

#### Changed
- Delegation policy is enforced while a run starts rather than described in advance. An Agent or Workflow run that pins no gateway identity is refused with the instruction to read gateway_models and pin one, and every turn carries that contract.
  ko: 위임 정책을 미리 설명하는 대신 실행 순간에 강제합니다. 게이트웨이 정체성을 핀하지 않은 Agent·Workflow 실행은 gateway_models를 읽고 정체성을 지정하라는 안내와 함께 거절되며, 그 규약이 매 턴 함께 실립니다.
