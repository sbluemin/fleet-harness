---
branch: fix/codex-grok-fallback-status
---

### fleet-console
#### Fixed
- An expired Codex CLI sign-in is no longer treated as usable, and `fleet gateway status` matches whether Codex or Grok can actually be used, including after you sign out.
  ko: 만료된 Codex CLI 로그인은 더 이상 사용할 수 있는 상태로 보지 않으며, `fleet gateway status`는 로그아웃 이후를 포함해 Codex나 Grok을 실제로 쓸 수 있는지를 그대로 보여 줍니다.
