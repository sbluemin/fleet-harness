---
branch: fix/lifecycle-wait-display
---

### fleet-console
#### Fixed
- While Console is still checking an update, it says it is preparing and keeps running, including after a refresh, instead of looking stopped or leaving the update button stuck.
  ko: 업데이트를 아직 확인하는 동안 Console은 준비 중이며 계속 실행 중이라고 알려 줍니다. 새로고침한 뒤에도 같고, 멈춘 것처럼 보이거나 업데이트 버튼이 그대로 멈추지 않습니다.

### fleet-desktop
#### Fixed
- While Desktop waits for a Console to start or shut down, the startup screen says what it is waiting for instead of saying it is checking for updates.
  ko: Desktop이 Console의 시작이나 종료를 기다리는 동안 시작 화면은 업데이트를 확인 중이라고 하지 않고, 무엇을 기다리는지 보여 줍니다.

### fleet-cli
#### Fixed
- `fleet console start` says when it is waiting for another Console to finish starting, and `fleet console stop` uses the same shutdown wait wording as the rest of Fleet.
  ko: `fleet console start`는 다른 Console이 시작을 끝낼 때까지 기다릴 때 그 사실을 알리고, `fleet console stop`은 Fleet의 다른 곳과 같은 종료 대기 문구를 씁니다.
