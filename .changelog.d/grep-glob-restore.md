---
branch: grep-glob-restore
---

### fleet-cli
#### Changed
- Agents now search with the dedicated Grep and Glob tools instead of shell commands alone. Cursor, Grok, and OpenCode models receive those tools and no longer carry the instruction that steered them back to the shell; Codex models keep working through the shell as before.
  ko: 에이전트가 셸 명령에만 기대지 않고 Grep, Glob 도구로 직접 검색합니다. Cursor·Grok·OpenCode 모델은 두 도구를 받고 셸로 되돌리던 지시문도 더 이상 싣지 않으며, Codex 모델은 종전대로 셸로 검색합니다.

### fleet-console
#### Changed
- Agents now search with the dedicated Grep and Glob tools instead of shell commands alone. Cursor, Grok, and OpenCode models receive those tools and no longer carry the instruction that steered them back to the shell; Codex models keep working through the shell as before.
  ko: 에이전트가 셸 명령에만 기대지 않고 Grep, Glob 도구로 직접 검색합니다. Cursor·Grok·OpenCode 모델은 두 도구를 받고 셸로 되돌리던 지시문도 더 이상 싣지 않으며, Codex 모델은 종전대로 셸로 검색합니다.
