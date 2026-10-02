---
branch: agent-call-member-redirect
---

### fleet-console
#### Changed
- Agents in Console no longer start hidden subagents; when they try, they are pointed to Objectives members, which you can see and follow on the board. Each Theater can turn this off from its System prompt sheet, and Workflows still run their agents.
  ko: 이제 Console의 에이전트는 보이지 않는 서브에이전트를 띄우지 않습니다. 띄우려 하면 보드에서 확인하고 따라갈 수 있는 Objectives 구성원에게 맡기도록 안내됩니다. Theater마다 시스템 프롬프트 시트에서 이 동작을 끌 수 있고, 워크플로는 지금처럼 에이전트를 실행합니다.
#### Added
- Objective Commanders can add members to an existing roster.
  ko: 목표의 지휘관이 이미 꾸려진 명단에 구성원을 더할 수 있습니다.
#### Removed
- The Built-in subagents list in Settings is gone; subagents are now chosen per Theater, and earlier per-name choices are not carried over.
  ko: Settings의 내장 서브에이전트 목록이 사라졌습니다. 서브에이전트는 이제 Theater마다 정하며, 이전의 이름별 선택은 옮겨지지 않습니다.
