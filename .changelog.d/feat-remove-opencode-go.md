---
branch: feat/remove-opencode-go
---

### fleet-console
#### Removed
- OpenCode Go is no longer an AI Gateway provider: its models, API key sign-in, and usage meter are gone from Console. Saved OpenCode Go models drop out of the roster, and a stored key is left in place but no longer used.
  ko: OpenCode Go는 더 이상 AI Gateway 공급자가 아닙니다. Console에서 해당 모델, API 키 로그인, 사용량 미터가 사라졌습니다. 저장해 둔 OpenCode Go 모델은 로스터에서 빠지고, 저장된 키는 지워지지 않지만 더 이상 쓰이지 않습니다.

### fleet-cli
#### Removed
- `fleet gateway` no longer offers OpenCode Go sign-in or reports its key in `fleet gateway status`; Providers now signs in only TypeSafe.
  ko: `fleet gateway`에서 OpenCode Go 로그인이 빠졌고 `fleet gateway status`도 그 키를 표시하지 않습니다. Providers 화면은 이제 TypeSafe 로그인만 제공합니다.
