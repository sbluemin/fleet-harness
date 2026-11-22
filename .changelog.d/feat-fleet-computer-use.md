---
branch: feat/fleet-computer-use
---

### fleet-console
#### Changed
- On macOS, agents use apps in the background with a separate Fleet cursor that leaves your pointer and front app alone. Computer Use no longer needs Codex or Cua Driver; it requires the Fleet Console desktop app.
  ko: macOS에서 에이전트가 내 포인터와 앞에 둔 앱을 건드리지 않고 Fleet 전용 커서로 백그라운드에서 앱을 사용합니다. 컴퓨터 사용에 더 이상 Codex나 Cua Driver가 필요하지 않으며, Fleet Console 데스크톱 앱이 필요합니다.
- The first time Computer Use needs Accessibility or Screen Recording, Fleet asks macOS for them, so the app appears in System Settings and you only need to turn it on. When both are missing, the Screen Recording prompt follows as soon as you turn on Accessibility. Permission messages name the app macOS actually checks and say what to do if the app isn't listed or doesn't reopen after Quit & Reopen.
  ko: 컴퓨터 사용에 손쉬운 사용·화면 기록 권한이 처음 필요해지면 Fleet이 macOS에 요청합니다. 앱이 시스템 설정 목록에 자동으로 올라오므로 켜기만 하면 됩니다. 둘 다 빠졌으면 손쉬운 사용을 켜는 즉시 화면 기록 요청이 이어서 뜹니다. 권한 안내는 macOS가 실제로 확인하는 앱 이름을 가리키고, 목록에 없거나 '종료 및 다시 열기' 뒤 다시 열리지 않을 때 할 일을 알려 줍니다.
#### Added
- Agents can file feedback tickets about Computer Use problems, saved in `~/.fleet/console/feedback/computer-use`.
  ko: 에이전트가 컴퓨터 사용 중 겪은 문제를 피드백 티켓으로 남기며, 티켓은 `~/.fleet/console/feedback/computer-use`에 저장됩니다.
#### Removed
- Computer Use is no longer available on Windows or Linux.
  ko: Windows와 Linux에서는 더 이상 컴퓨터 사용을 쓸 수 없습니다.
