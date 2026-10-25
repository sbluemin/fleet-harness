---
branch: fix/update-respawn-cwd
---

### fleet-console
#### Fixed
- Updating from inside Console no longer leaves it stopped when Console was first started by `fleet update`; the updated Console now comes back on its own.
  ko: `fleet update`가 처음 띄운 Console에서 앱 안 업데이트를 실행해도 더 이상 Console이 멈춘 채로 남지 않고, 업데이트된 Console이 스스로 다시 올라옵니다.
