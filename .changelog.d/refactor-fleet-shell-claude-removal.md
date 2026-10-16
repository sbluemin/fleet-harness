---
branch: refactor/fleet-shell-claude-removal
---

### fleet-cli
#### Removed
- The shell `fleet` command no longer runs Claude Code. It manages Console and configures the AI Gateway; `gateway serve`, `gateway auth`, `fleet auth`, and `doctor` are gone. Claude Code inside a Console CLI Operation is unchanged.
  ko: 셸의 `fleet`은 더 이상 Claude Code를 실행하지 않습니다. Console 관리와 AI Gateway 설정만 남고, `gateway serve`, `gateway auth`, `fleet auth`, `doctor`는 제거되었습니다. Console 안의 CLI Operation은 그대로입니다.
