---
branch: fix-awaiting-to-running-regression
---

### fleet-console
#### Fixed
- Return an Agent Operation to running as soon as you answer its question in the terminal, instead of leaving it marked as waiting for input until the turn ends.
  ko: 터미널에서 질문에 답하면 Agent Operation이 곧바로 실행 중으로 돌아오도록 고쳤습니다. 이전에는 턴이 끝날 때까지 입력 대기로 남아 있었습니다.
- Read an Operation as running background work once its turn has ended, so subagents and workflows that outlive the turn no longer read as a running turn.
  ko: 턴이 끝난 뒤 남은 서브에이전트·워크플로우 작업은 실행 중이 아니라 백그라운드로 표시합니다.
