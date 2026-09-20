---
branch: builtin-subagent-checkboxes
---

### fleet-console
#### Changed
- Settings now lists Claude Code's built-in subagents as a grouped checklist with a one-line description of what each one does, instead of a column of switches with bare names.
  ko: 설정의 Claude Code 내장 서브에이전트가 이름만 적힌 스위치 목록 대신, 하는 일을 한 줄로 설명하는 묶음별 체크 목록으로 바뀌었습니다.

#### Fixed
- Turning several subagents on or off in a row no longer drops the ones you picked while the previous change was still saving.
  ko: 서브에이전트를 연달아 켜고 끌 때 앞의 변경이 저장되는 동안 누른 항목이 사라지지 않습니다.
- Subagents you turned off stay visible and reversible even when Fleet cannot read the installed Claude Code.
  ko: 설치된 Claude Code를 읽지 못하는 상황에서도 꺼 둔 서브에이전트가 목록에 남아 다시 켤 수 있습니다.
- Checkboxes now show a check mark instead of an upward chevron.
  ko: 체크박스에 꺾쇠 대신 체크 표시가 나타납니다.
