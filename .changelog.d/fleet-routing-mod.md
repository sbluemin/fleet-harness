---
branch: fleet-routing-mod
---

### fleet-console
#### Added
- Delegated work runs on your gateway models without the agent having to name one. Fleet assigns each subagent and workflow stage a model as it starts, and the weight the agent asks for also sets how hard that run thinks, within the reasoning levels you exposed.
  ko: 위임한 작업이 에이전트가 모델을 지목하지 않아도 게이트웨이 모델에서 돕니다. 서브에이전트와 워크플로 스테이지가 시작될 때 Fleet이 모델을 배정하고, 에이전트가 요청한 무게가 그 실행의 추론 강도까지 정하며 내보낸 강도 안에서만 움직입니다.
- Settings → AI Gateway carries a Routing card that turns the assignment off and leaves delegation to Claude Code.
  ko: Settings → AI Gateway에 라우팅 카드가 생겨, 배정을 끄고 위임을 Claude Code에 맡길 수 있습니다.
#### Changed
- Enabling a gateway model now reaches delegated runs on the next run instead of the next session.
  ko: 게이트웨이 모델을 켜면 다음 세션이 아니라 다음 실행부터 위임에 반영됩니다.
