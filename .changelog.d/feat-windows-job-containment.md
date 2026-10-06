---
branch: feat/windows-job-containment
---

### fleet-console
#### Fixed
- On Windows, stopping or killing Console also ends the programs it started and their children, instead of leaving them behind or waiting out a stuck stop. On macOS and Linux, stopping Console now also ends background helpers left by an agent that has already exited.
  ko: Windows에서 Console을 멈추거나 끝내면 Console이 시작한 프로그램과 그 자식 프로그램도 함께 종료돼, 프로세스가 남거나 종료가 제한 시간까지 끌리는 일을 막습니다. macOS와 Linux에서도 이미 끝난 에이전트가 남긴 백그라운드 보조 프로세스를 Console 종료 시 함께 정리합니다.
