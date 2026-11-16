---
branch: fix/turn-failure-recovery
---

### fleet-console
#### Fixed
- A failed Commodore turn now says why in one line, and a message that can't be processed is marked as not processed instead of blocking every message sent after it.
  ko: 사령관 턴이 실패하면 이유가 한 줄로 표시되고, 처리할 수 없는 메시지는 「처리 불가」로 남겨 이후 대화를 막지 않습니다.
#### Added
- Retry a failed turn in a fresh session, or skip just the message that keeps failing, from the warning line, without clearing the conversation.
  ko: 경고 줄에서 실패한 턴을 새 세션으로 다시 시도하거나, 계속 실패하는 메시지만 건너뛸 수 있습니다. 대화 기록을 지우지 않아도 됩니다.
