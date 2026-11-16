# 실행 활동 상태 참조

SDK 활동, job ledger 또는 Objective 세션 수명주기를 수정할 때 읽는다. 상태의 권위·수명주기·실패 처리 근거를 보존한다.

## Objective 활동의 권위

모든 Objective 세션은 Chat SDK로 실행한다. SDK 턴 경계가 working을, 승인 대기가 awaiting을, 세션의 live job ledger가 background-pending을 소유한다. background-pending은 working을 대신하지 않으며 거짓 idle만 막는다. 턴이 진행 중이면 working이 먼저 보이고, 턴이 끝난 뒤에도 에이전트 작업이 남았을 때 background-pending이 드러난다. 턴 종료만으로 백그라운드 작업 집합을 비우지 않는다.

활동 필드는 한 벌이다. SDK 자식이 아직 열리지 않았다는 이유로 다른 표면의 상태를 만들지 않는다. 복원된 Objective 세션은 자식 없이도 live/idle이며, 이력·상태 조회만으로 자식을 열지 않는다. Objective에는 PTY 표면·전환·휴면 재개 경로가 없다. 셸과 독립 Claude CLI의 공유 PTY transport는 별도로 유지한다.

## 백그라운드 작업 집합

`chat-session.ts`의 `trackJob`과 `syncBackgroundPending`이 SDK 스트림의 작업 상태를 집계한다.

- `job`은 실행 중 집합에 넣고 이전 종료 기억을 지운다. 같은 id의 새 시작을 종료된 resident 작업으로 오인하면 안 된다.
- `job-end`는 실행 중 집합에서 빼고 종료 기억을 남긴다. 종료된 named agent가 목록에 계속 남아 있어도 다시 pending으로 세지 않는다.
- `jobs`는 증감 카운터가 아니라 전체 집합의 교체다. 한 Workflow 호출이 여러 자식을 만들 수 있으므로 spawn/stop 횟수 차로 작업 수를 추정하지 않는다. 목록에서 사라진 id의 종료 기억은 정리한다.
- pending으로 세는 것은 `agent`와 `workflow` 작업이다. 백그라운드 셸 명령과 세션에 상주하는 MCP 감시는 사람이 기다리는 에이전트 작업과 다르다. 처음 보는 kind는 pending에 넣지 않으며, kind가 빠진 행은 이미 알려진 kind를 덮지 않는다.
- ledger에는 TTL을 두지 않는다. SDK 스트림의 작업 상태를 시간 만료로 지우면 실제로 진행 중인 작업을 idle로 표시한다. 세션 종료 시 ledger를 정리한다.
- 집합이 바뀔 때 pending의 절대값을 보고한다. 마지막 전송값을 별도 소유권 상태로 취급하지 않으며, 같은 값인지는 활동 필드를 가진 쪽에서 판단한다.

## 종료와 대화 보존

한 대화에는 writer가 하나만 있어야 한다. 세션 교체·종료는 이전 SDK writer의 정리를 기다리고, 복원은 저장된 대화 정체성을 따른다. 저장된 transcript가 사라졌다고 자동으로 새 대화를 만들지 않는다. 새 대화는 명시적 fresh 요청의 계약을 따른다.

외부 Fleet command hook과 Objective PTY의 OSC title·hook TTL·표면 전환 규칙은 퇴역한 실행 경로의 규칙이다. 이를 SDK ledger의 새 타임아웃이나 호환 어댑터로 되살리지 않는다.
