---
branch: fleet-routing-mod
---

### fleet-cli
#### Added
- Gateway models you enable now reach a session as delegation identities without a plugin rebuild, so turning one on or off takes effect on the next session rather than after the plugin tree is republished.
  ko: 활성화한 게이트웨이 모델이 플러그인 재생성 없이 세션의 위임 정체성으로 올라오므로, 모델을 켜고 끄면 플러그인 트리가 다시 발행되기를 기다리지 않고 다음 세션부터 반영됩니다.
- A Fleet Routing panel shows each delegated run from the moment it starts: what was requested, which model carried it, and why that model was chosen. Workflow stages appear too, marked as runs Fleet did not route. Open it any time with `/fleet-routing`.
  ko: Fleet Routing 판이 위임 실행을 시작 시점부터 보여줍니다 — 무엇을 요청했고, 어느 모델이 실행했으며, 그 모델이 선택된 이유가 표시됩니다. 워크플로우 단계도 Fleet이 배정하지 않은 실행으로 표시되어 함께 나타납니다. `/fleet-routing`으로 언제든 열 수 있습니다.

### fleet-console
#### Added
- Gateway models you enable now reach a session as delegation identities without a plugin rebuild, so turning one on or off takes effect on the next session rather than after the plugin tree is republished.
  ko: 활성화한 게이트웨이 모델이 플러그인 재생성 없이 세션의 위임 정체성으로 올라오므로, 모델을 켜고 끄면 플러그인 트리가 다시 발행되기를 기다리지 않고 다음 세션부터 반영됩니다.
