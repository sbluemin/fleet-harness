---
branch: sysprompt-removal
---

### fleet-cli
#### Changed
- Gateway sessions no longer carry a Fleet system prompt or Fleet skills. Each turn states the pin contract instead, and a delegation that names no gateway identity is refused with instructions rather than quietly running on the session's own model.
  ko: 게이트웨이 세션이 Fleet 시스템 프롬프트와 Fleet 스킬을 더 이상 싣지 않습니다. 대신 매 턴 핀 규약을 알리고, 게이트웨이 정체성을 지정하지 않은 위임은 세션 자신의 모델로 조용히 실행되는 대신 방법을 안내하며 거절합니다.

### fleet-console
#### Removed
- The Fleet system prompt mode setting is gone. Gateway sessions and Chat Mode no longer receive a Fleet system prompt, so its Append and Replace compositions have nothing left to compose.
  ko: Fleet 시스템 프롬프트 모드 설정이 사라졌습니다. 게이트웨이 세션과 Chat Mode가 Fleet 시스템 프롬프트를 더 이상 받지 않아 Append/Replace 조합이 조합할 대상을 잃었습니다.

#### Added
- Settings now carries one Claude Code system prompt switch. On keeps Claude Code's own prompt, and Off replaces it with an empty one, which measures 6,490 fewer input tokens per turn in a terminal session and 6,360 in Chat. It binds new sessions in both the terminal and Chat, and a running session keeps the prompt it launched with.
  ko: 설정에 Claude Code 시스템 프롬프트 스위치 하나가 생겼습니다. On은 Claude Code 자체 프롬프트를 유지하고, Off는 그것을 빈 프롬프트로 대체해 터미널 세션은 턴당 입력 토큰 6,490개, 채팅은 6,360개가 줄어듭니다. 터미널과 채팅의 새 세션에 함께 적용되며, 실행 중인 세션은 띄울 때의 프롬프트를 유지합니다.

#### Changed
- Delegation policy is enforced while a run starts rather than described in advance. An Agent or Workflow run that pins no gateway identity is refused with the instruction to read gateway_models and pin one, and every turn carries that contract.
  ko: 위임 정책을 미리 설명하는 대신 실행 순간에 강제합니다. 게이트웨이 정체성을 핀하지 않은 Agent·Workflow 실행은 gateway_models를 읽고 정체성을 지정하라는 안내와 함께 거절되며, 그 규약이 매 턴 함께 실립니다.
