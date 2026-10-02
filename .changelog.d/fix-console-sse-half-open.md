---
branch: fix/console-sse-half-open
---

### fleet-console
#### Fixed
- Console now notices when its live connection silently stalls, such as after sleep or a network change, and reconnects within about a minute, catching up on Operation and objective changes without a page reload.
  ko: 잠자기나 네트워크 전환 뒤처럼 실시간 연결이 오류 없이 멈춰도 Console이 1분 남짓 안에 알아채 다시 연결하고, 그사이 놓친 Operation과 목표 변경을 새로고침 없이 반영합니다.
