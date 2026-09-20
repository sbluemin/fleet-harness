---
branch: harness-system-prompt
---

### fleet-console
#### Added
- Write your own system prompt in Settings and have it reach every new session, either after Claude Code's own prompt or in place of it.
  ko: Settings에서 내 시스템 프롬프트를 작성해 모든 새 세션에 실을 수 있습니다. Claude Code 기본 프롬프트 뒤에 잇거나, 그 자리를 대신하게 할 수 있습니다.

#### Fixed
- Chat no longer fails every turn when the Claude Code system prompt is turned off, and turning it on now loads that prompt in Chat as it already did in the terminal.
  ko: Claude Code 시스템 프롬프트를 껐을 때 채팅의 모든 턴이 실패하던 문제를 고쳤습니다. 켠 상태에서는 터미널과 마찬가지로 채팅에서도 그 프롬프트가 실립니다.
