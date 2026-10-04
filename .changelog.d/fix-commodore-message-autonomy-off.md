---
branch: fix/commodore-message-autonomy-off
---

### fleet-console
#### Fixed
- A message to the Commodore no longer disappears silently while autonomous operation is off: the Commodore sheet's message box waits until it is on and keeps your draft, a message sent just as it was turned off comes back as an error, and one the Commodore never got to read is marked "Not delivered" in its log.
  ko: 자율 운영이 꺼진 동안 사령관에게 보낸 메시지가 더 이상 조용히 사라지지 않습니다. 사령관 시트의 입력창은 자율 운영을 켤 때까지 잠기고 쓰던 내용은 남으며, 막 꺼진 순간에 보낸 메시지는 오류로 돌아오고, 사령관이 읽지 못한 메시지는 기록에 「전달되지 않음」으로 표시됩니다.
