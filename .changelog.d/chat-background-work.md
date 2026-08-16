---
branch: chat-background-work
---

### fleet-console
#### Added
- Chat Mode now tracks background work (subagents, dynamic workflows and background shells) on its own clock. A backgrounded call keeps its own card instead of folding away, a strip above the reply control counts what is still running, and a Work tab lists every job with the model, tokens and duration behind it. A dynamic workflow opens into its stage tree, one row per agent with the identity it was pinned to, and a subagent opens into the report it returned.
  ko: 채팅 모드가 백그라운드 작업(서브에이전트·다이나믹 워크플로·백그라운드 셸)을 자기 시계로 추적합니다. 백그라운드로 넘어간 호출은 접히지 않고 자기 카드를 지키고, 회신 컨트롤 위의 줄이 아직 도는 작업 수를 세며, 작업 탭이 모델·토큰·소요 시간과 함께 전체 목록을 보여 줍니다. 다이나믹 워크플로는 단계 트리로 펼쳐져 에이전트마다 핀된 신원을 보이고, 서브에이전트는 자신이 돌려준 보고를 펼칩니다.

#### Fixed
- A turn that left work running no longer closes with a check mark on it. The fold now says how many jobs are still running, and a job that was cut short before finishing says so instead of reading as completed.
  ko: 아직 도는 작업을 남긴 턴이 그 작업에 완료 표시를 찍고 닫히지 않습니다. 접힘 줄이 남은 작업 수를 말하고, 끝나기 전에 거둬진 작업은 완료가 아니라 거둬졌다고 말합니다.
- When background work finishes and the model answers again, that answer opens its own turn instead of replacing the answer of the turn that started the work.
  ko: 백그라운드 작업이 끝나 모델이 다시 답할 때, 그 답이 작업을 시작한 턴의 답을 갈아치우지 않고 자기 턴으로 섭니다.
