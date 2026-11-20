---
branch: feat/standalone-cli-global-plugins
---

### fleet-console
#### Added
- Plugins you install globally for Commodores now also load in the Claude Code and Antigravity CLIs opened with Ctrl+`. Antigravity gets them for that session only, without changing your own Antigravity setup, and skips parts it cannot run, such as LSP servers and output styles.
  ko: 사령관용으로 전역 설치한 플러그인이 이제 Ctrl+`로 여는 Claude Code와 Antigravity CLI에도 함께 실립니다. Antigravity에는 그 세션에만 실려 내 Antigravity 설정은 바뀌지 않으며, LSP 서버나 출력 스타일처럼 Antigravity가 실행할 수 없는 부분은 건너뜁니다.
