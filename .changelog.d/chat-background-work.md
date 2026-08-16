---
branch: chat-background-work
---

### fleet-console
#### Added
- Chat Mode now tracks background work (subagents, dynamic workflows and background shells) on its own clock. A backgrounded call keeps its own card instead of folding away, and a strip above the reply control counts what is still running. Clicking that strip opens the work surface beside the conversation rather than in place of it: a column on a wide panel, a drawer on a narrow one, resizable either way. A dynamic workflow opens into its stage tree, one row per agent with the identity it was pinned to. A subagent opens into the report it returned plus the trail of tools it actually called, and a background shell opens into the tail of what it printed.
  ko: 채팅 모드가 백그라운드 작업(서브에이전트·다이나믹 워크플로·백그라운드 셸)을 자기 시계로 추적합니다. 백그라운드로 넘어간 호출은 접히지 않고 자기 카드를 지키고, 회신 컨트롤 위의 줄이 아직 도는 작업 수를 셉니다. 그 줄을 누르면 작업 면이 대화를 대신하지 않고 대화 옆에 섭니다 — 넓은 패널에서는 오른쪽 컬럼, 좁은 패널에서는 아래 서랍이며 양쪽 모두 크기를 조절할 수 있습니다. 다이나믹 워크플로는 단계 트리로 펼쳐져 에이전트마다 핀된 신원을 보이고, 서브에이전트는 자신이 돌려준 보고와 함께 실제로 부른 도구의 발자국을 펼치며, 백그라운드 셸은 자신이 찍은 출력의 꼬리를 펼칩니다.
- Chat Mode can stop a turn that is going the wrong way. The control stands next to the reply button while a turn is in flight, and the turn it closes reads as stopped rather than failed, keeping whatever the model had already written. Background work that was already started keeps running, and the work surface still reports it.
  ko: 채팅 모드에서 엉뚱한 방향으로 가는 턴을 중지할 수 있습니다. 턴이 도는 동안 회신 버튼 옆에 컨트롤이 서고, 그렇게 닫힌 턴은 실패가 아니라 중지로 읽히며 모델이 이미 쓴 내용은 그대로 남습니다. 이미 시작된 백그라운드 작업은 계속 돌고, 작업 면이 그것을 그대로 보고합니다.

#### Fixed
- A turn that left work running no longer closes with a check mark on it. The fold now says how many jobs are still running, and a job that was cut short before finishing says so instead of reading as completed.
  ko: 아직 도는 작업을 남긴 턴이 그 작업에 완료 표시를 찍고 닫히지 않습니다. 접힘 줄이 남은 작업 수를 말하고, 끝나기 전에 거둬진 작업은 완료가 아니라 거둬졌다고 말합니다.
- A collapsed row of tool calls now looks like something you can open before you hover it. The tool's name reads a step brighter than the words around it, and the chevron that opens the row is large enough to see at rest.
  ko: 접힌 도구 호출 줄이 마우스를 올리기 전에도 눌리는 것으로 보입니다. 도구 이름이 주변 문구보다 한 단 밝게 읽히고, 줄을 펴는 꺾쇠가 쉬는 상태에서도 보일 만큼 커졌습니다.
- When background work finishes and the model answers again, that answer opens its own turn instead of replacing the answer of the turn that started the work.
  ko: 백그라운드 작업이 끝나 모델이 다시 답할 때, 그 답이 작업을 시작한 턴의 답을 갈아치우지 않고 자기 턴으로 섭니다.
