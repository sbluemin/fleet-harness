---
branch: chat-terminal-font
---

### fleet-console
#### Changed
- Chat view now follows your Terminal Font for everything except markdown-rendered answers, so switching an Operation between the CLI view and the chat view keeps one typeface.
  ko: 채팅 뷰가 마크다운으로 렌더된 답변을 뺀 나머지 전부를 터미널 글꼴로 그립니다. 같은 Operation을 CLI 뷰와 채팅 뷰로 오가도 서체가 하나로 유지됩니다.

#### Fixed
- Korean text in the chat log and in terminal panels now renders in a bundled monospace face instead of dropping to a system fallback, so Hangul no longer sits at a different weight and width from the Latin text beside it.
  ko: 채팅 로그와 터미널 패널의 한글이 시스템 대체 글꼴로 새지 않고 번들 등폭 서체로 그려집니다. 한글이 옆의 라틴 문자와 굵기·폭이 어긋나 보이던 문제가 사라집니다.
