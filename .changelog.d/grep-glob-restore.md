---
branch: grep-glob-restore
---

### fleet-cli
#### Changed
- Agents now search with the dedicated Grep and Glob tools instead of shell commands alone, and the shell-first instruction that steered them away is no longer forwarded to Cursor, Grok, or OpenCode models.
  ko: 에이전트가 셸 명령에만 기대지 않고 Grep, Glob 도구로 직접 검색합니다. 그쪽으로 몰던 셸 우선 지시문은 Cursor, Grok, OpenCode 모델에 더 이상 전달되지 않습니다.

### fleet-console
#### Changed
- Agents now search with the dedicated Grep and Glob tools instead of shell commands alone, and the shell-first instruction that steered them away is no longer forwarded to Cursor, Grok, or OpenCode models.
  ko: 에이전트가 셸 명령에만 기대지 않고 Grep, Glob 도구로 직접 검색합니다. 그쪽으로 몰던 셸 우선 지시문은 Cursor, Grok, OpenCode 모델에 더 이상 전달되지 않습니다.
