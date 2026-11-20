---
branch: feat/standalone-cli-global-plugins
---

### fleet-console
#### Added
- Plugins you install globally for Commodores now also load in the Claude Code and Antigravity CLIs opened with Ctrl+`. Antigravity gets them for that session only, without changing your own Antigravity setup, and skips parts it cannot run, such as LSP servers; to sign in to a plugin's MCP server in Antigravity, install that plugin in Antigravity itself, and your copy is used instead.
  ko: 사령관용으로 전역 설치한 플러그인이 이제 Ctrl+`로 여는 Claude Code와 Antigravity CLI에도 함께 실립니다. Antigravity에는 그 세션에만 실려 내 Antigravity 설정은 바뀌지 않으며, LSP 서버처럼 실행할 수 없는 부분은 건너뜁니다. Antigravity에서 플러그인 MCP 서버에 로그인하려면 그 플러그인을 Antigravity에 직접 설치하세요. 그러면 직접 설치한 쪽이 쓰입니다.
