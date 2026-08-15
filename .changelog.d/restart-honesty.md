---
branch: restart-honesty
---

### fleet-console
#### Changed
- Restored sessions after a Console restart now share one Ended signal and a start-again path, instead of painting a dead process as idle.
  ko: 콘솔을 다시 연 뒤 복원된 세션은 죽은 프로세스를 유휴로 그리지 않고, 같은 종료됨 신호와 다시 시작 경로를 씁니다.
- A rejected rename, accent, or group edit rolls the panel back to the server value and offers Try again, instead of looking saved.
  ko: 거절된 이름·액센트·그룹 변경은 저장된 것처럼 보이지 않고, 서버 값으로 되돌린 뒤 다시 시도를 줍니다.
#### Fixed
- Restored Codex and other Agent CLI sessions no longer inherit a Claude supplier mark when the launch record was missing.
  ko: 실행 기록이 없는 복원 Codex 등 Agent CLI 세션이 Claude 공급자 마크를 물려받지 않습니다.
