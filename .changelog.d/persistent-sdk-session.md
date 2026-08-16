---
branch: persistent-sdk-session
---

### fleet-console
#### Changed
- Chat Mode keeps its agent session alive for as long as the Operation is open, so background shells, subagents, and workflows outlive the turn that started them and report back when they settle.
  ko: Chat Mode가 Operation이 열려 있는 동안 에이전트 세션을 살려 두어, 백그라운드 셸·서브에이전트·워크플로가 자기를 시작한 턴보다 오래 살고 끝날 때 결말을 보고합니다.
- Stopping a chat turn now interrupts the agent instead of ending its session, so background work started earlier keeps running.
  ko: 채팅 턴 중지가 세션을 끝내는 대신 에이전트를 중단시켜, 앞서 시작된 백그라운드 작업이 계속 돕니다.

#### Added
- Running background jobs can be stopped one at a time from the job detail view.
  ko: 도는 백그라운드 작업을 작업 상세에서 하나씩 중단할 수 있습니다.
