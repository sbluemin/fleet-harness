---
branch: feat/windows-job-containment
---

### fleet-console
#### Fixed
- On Windows, stopping or killing Console also ends the programs it started and the programs those started, instead of leaving them behind or waiting out the stop when one of them is stuck.
  ko: Windows에서 Console을 멈추거나 끝내면 Console이 시작한 프로그램과 그 프로그램이 시작한 프로그램도 함께 끝나며, 하나가 멈춰 있어도 종료가 제한 시간까지 끌리지 않습니다.
