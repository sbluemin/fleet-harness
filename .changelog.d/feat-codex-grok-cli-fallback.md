---
branch: feat/codex-grok-cli-fallback
---

### fleet-console
#### Added
- Codex and Grok use an existing CLI sign-in when Console has none, and ask you to sign in when that sign-in is missing or the Codex one has expired. Signing out stays signed out, and `fleet gateway status` shows that same state.
  ko: Codex와 Grok은 Console에 로그인이 없으면 기존 CLI 로그인을 쓰고, 그 로그인이 없거나 Codex 로그인이 만료되면 로그인을 안내합니다. 로그아웃은 유지되며 `fleet gateway status`도 그 상태를 보여 줍니다.
