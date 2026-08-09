---
branch: fix-opencode-go-api-key-save
---

### fleet-console
#### Fixed
- Give AI Gateway API key sign-in enough time for the live validation probe to return, so a slow OpenCode Go response no longer fails as a timeout before the key is stored.
  ko: AI Gateway API 키 로그인 검증 프로브가 돌아올 시간을 늘려, OpenCode Go 응답이 느려도 타임아웃으로 키가 저장되지 않던 문제를 고칩니다.

### fleet-cli
#### Fixed
- Give AI Gateway API key login enough time for the live validation probe to return, so a slow OpenCode Go response no longer fails as a timeout before the key is stored.
  ko: AI Gateway API 키 로그인 검증 프로브가 돌아올 시간을 늘려, OpenCode Go 응답이 느려도 타임아웃으로 키가 저장되지 않던 문제를 고칩니다.
