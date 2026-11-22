---
branch: feat/fleet-computer-use
---

### fleet-console
#### Changed
- On macOS, agents use apps in the background with a separate Fleet cursor that leaves your pointer and front app alone. Computer Use no longer needs Codex or Cua Driver; it requires the Fleet Console desktop app.
  ko: macOS에서 에이전트가 내 포인터와 앞에 둔 앱을 건드리지 않고 Fleet 전용 커서로 백그라운드에서 앱을 사용합니다. 컴퓨터 사용에 더 이상 Codex나 Cua Driver가 필요하지 않으며, Fleet Console 데스크톱 앱이 필요합니다.
#### Added
- Agents can file feedback tickets about Computer Use problems, saved in `~/.fleet/console/feedback/computer-use`.
  ko: 에이전트가 컴퓨터 사용 중 겪은 문제를 피드백 티켓으로 남기며, 티켓은 `~/.fleet/console/feedback/computer-use`에 저장됩니다.
#### Removed
- Computer Use is no longer available on Windows or Linux.
  ko: Windows와 Linux에서는 더 이상 컴퓨터 사용을 쓸 수 없습니다.
