---
branch: fleet-routing-mod
---

### fleet-cli
#### Added
- Delegated runs are now assigned to a gateway model by Fleet instead of being left to the agent's own choice, so a run started without naming a model no longer falls back to the model your session is already paying for.
  ko: 위임 실행의 모델을 에이전트의 선택에 맡기지 않고 Fleet이 배정하므로, 모델을 지정하지 않고 시작한 실행이 이미 사용 중인 세션 모델로 되돌아가지 않습니다.
- A Fleet Routing panel shows each delegated run from the moment it starts: what was requested, which model carried it, and why that model was chosen. Workflow stages appear too, marked as runs Fleet did not route. Open it any time with `/fleet-routing`.
  ko: Fleet Routing 판이 위임 실행을 시작 시점부터 보여줍니다 — 무엇을 요청했고, 어느 모델이 실행했으며, 그 모델이 선택된 이유가 표시됩니다. 워크플로우 단계도 Fleet이 배정하지 않은 실행으로 표시되어 함께 나타납니다. `/fleet-routing`으로 언제든 열 수 있습니다.

### fleet-console
#### Added
- Delegated runs are now assigned to a gateway model by Fleet instead of being left to the agent's own choice, so a run started without naming a model no longer falls back to the model your session is already paying for.
  ko: 위임 실행의 모델을 에이전트의 선택에 맡기지 않고 Fleet이 배정하므로, 모델을 지정하지 않고 시작한 실행이 이미 사용 중인 세션 모델로 되돌아가지 않습니다.
