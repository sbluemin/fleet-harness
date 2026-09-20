---
branch: chat-work-density
---

### fleet-console
#### Changed
- Background work in chat now fits where you are reading it: the running-jobs line moved into the row above the message box instead of taking a row of its own, finished jobs fold into the step summary that already counts the turn's work, and the work panel lists jobs one per line under collapsible groups for subagents, shells and workflows, with any failures still named on the collapsed group.
  ko: 채팅의 백그라운드 작업이 읽던 자리 안에 들어옵니다. 실행 중인 작업 줄은 자기 행을 따로 쓰지 않고 입력창 위 한 줄의 가운데로 들어가고, 끝난 작업은 그 턴이 한 일을 이미 세고 있던 집계 줄로 접힙니다. 작업 패널은 잡을 한 줄씩 세우고 서브에이전트·셸·워크플로로 묶어 접을 수 있으며, 접은 묶음에도 실패한 수는 그대로 남습니다.
- Expanding a step summary now shows the calls as a single time-ordered tree instead of stacked boxes, so a long turn stays readable.
  ko: 집계 줄을 펼치면 상자가 쌓이는 대신 시간순 트리 하나로 서서, 긴 턴도 그대로 읽힙니다.

#### Fixed
- The finished section of the work panel said "Done" while it also held failed, stopped and unknown jobs; it now says "Ended".
  ko: 작업 패널에서 끝난 잡을 모은 구역이 실패·중단·결과 미상을 담고도 「완료」라고 적혀 있었습니다. 이제 「끝남」으로 섭니다.
