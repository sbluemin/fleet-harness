---
branch: claude-builtin-agents-optout
---

### fleet-console
#### Added
- Settings > Harness > Claude Code lists the built-in subagents reported by the installed Claude Code and lets you turn individual ones off for new sessions; the list is read from the CLI itself, so an update that adds or removes a subagent is reflected without a Fleet change.
  ko: Settings > 하네스 > Claude Code에서 설치된 Claude Code가 보고하는 내장 서브에이전트를 보여 주고 새 세션에서 개별로 끌 수 있습니다. 목록은 CLI 자체에서 읽으므로 업데이트로 서브에이전트가 추가·제거되면 Fleet 변경 없이 반영됩니다.

### fleet-cli
#### Added
- The `fleet` launcher honors the built-in subagent opt-out chosen in Console Settings.
  ko: `fleet` 런처가 Console Settings에서 고른 내장 서브에이전트 옵트아웃을 따릅니다.
