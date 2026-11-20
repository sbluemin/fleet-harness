---
branch: feat/standalone-cli-global-plugins
---

### fleet-console
#### Added
- Plugins you install globally for Commodores now also load in the Claude Code and Antigravity CLIs opened with Ctrl+`. In Claude Code they replace a plugin of the same name you installed there. Antigravity gets them for that session only, without changing your own Antigravity setup, keeps using a plugin of the same name you installed in Antigravity, and skips parts it cannot run, such as LSP servers. Antigravity cannot sign in to a plugin MCP server loaded this way, so install a plugin that needs sign-in in Antigravity itself.
  ko: 사령관용으로 전역 설치한 플러그인이 이제 Ctrl+`로 여는 Claude Code와 Antigravity CLI에도 함께 실립니다. Claude Code에서는 같은 이름으로 직접 설치한 플러그인을 대신합니다. Antigravity에는 그 세션에만 실려 내 Antigravity 설정은 바뀌지 않고, Antigravity에 같은 이름으로 직접 설치한 플러그인이 있으면 그쪽을 그대로 쓰며, LSP 서버처럼 실행할 수 없는 부분은 건너뜁니다. 이렇게 실린 플러그인의 MCP 서버에는 Antigravity에서 로그인할 수 없으므로, 로그인이 필요한 플러그인은 Antigravity에 직접 설치하세요.
