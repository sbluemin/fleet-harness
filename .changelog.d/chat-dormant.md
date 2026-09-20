---
branch: chat-dormant
---

### fleet-console
#### Added
- Put a chat Operation to sleep with two presses of Ctrl+C, and resume it later with its conversation intact.
  ko: 채팅 Operation을 Ctrl+C 두 번으로 휴면 상태로 보내고, 나중에 재개하면 이전 대화가 그대로 복원됩니다.

#### Changed
- Chat Operations now rest like terminal ones: they come back dormant after the console restarts, and the idle timeout can put them to sleep.
  ko: 채팅 Operation도 터미널과 같이 쉽니다. 콘솔을 다시 시작하면 휴면 상태로 복원되고, 유휴 시간이 지나면 자동으로 휴면으로 전환됩니다.
