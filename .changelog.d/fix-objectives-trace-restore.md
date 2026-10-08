---
branch: fix/objectives-trace-restore
---

### fleet-console
#### Added
- Objectives mission rows show when the Commander's message reached the assigned member and when the member picked it up, without keeping the message itself.
  ko: Objectives 임무 행에 지휘관의 말이 담당 구성원에게 닿은 시각과 구성원이 그 일을 집어 든 시각이 보이며, 메시지 본문은 남기지 않습니다.

#### Fixed
- Objectives now tell the Commander, and show on the member's row, when a member's turn ends normally but no report reached anyone, with that turn's last response kept word for word. A member whose session offers no way to report is marked on the roster.
  ko: 구성원의 턴이 정상 종료됐지만 아무에게도 보고가 닿지 않았을 때, Objectives가 지휘관에게 알리고 구성원 행에 표시하며 그 턴의 마지막 응답을 원문 그대로 남깁니다. 세션에 보고할 수단이 없는 구성원은 명단에 표시됩니다.
- A member model switch that the session refuses now stays on the member's row and in the Commodore's failed-switch list with the session's own reason, instead of disappearing without a trace.
  ko: 세션이 거절한 구성원 모델 변경이 흔적 없이 사라지지 않고, 세션이 밝힌 사유와 함께 구성원 행과 Commodore의 실패한 전환 목록에 남습니다.
- A stopped objective shows as stopped and no longer wakes its Commander about missing reports until it is given an instruction again.
  ko: 멈춘 목표는 멈춤으로 표시되고, 다시 지시를 받기 전까지 보고가 없다며 지휘관을 깨우지 않습니다.
- A member's failed or unreported turn stays on the roster and inbox after a restart, and the Commander is not notified about it again.
  ko: 구성원의 실패·무보고 턴이 재시작 뒤에도 명단과 inbox에 남고, 지휘관에게 다시 알리지 않습니다.
