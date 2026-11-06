---
branch: fix/codex-strict-opt-out
---

### fleet-console
#### Fixed
- Tools sent to Codex stay out of strict mode unless the tool explicitly turns strict on, so optional arguments are not all required.
  ko: Codex로 보내는 도구는 strict를 명시하지 않으면 strict 모드로 바뀌지 않아, 선택 인자를 모두 필수로 두지 않습니다.
