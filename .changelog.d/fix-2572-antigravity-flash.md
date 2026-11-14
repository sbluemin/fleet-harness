---
branch: fix/2572-antigravity-flash
---

### fleet-console
#### Fixed
- Stop the Console window from briefly flashing on Windows by no longer running the Antigravity CLI to renew credentials there. When an Antigravity token lapses on Windows, run agy yourself to sign in again.
  ko: Windows에서 Antigravity 자격 증명 갱신을 위해 CLI를 실행하지 않아 콘솔 창이 깜빡이던 현상을 수정했습니다. Windows에서 Antigravity 토큰이 만료되면 agy를 직접 실행해 다시 로그인해 주세요.
