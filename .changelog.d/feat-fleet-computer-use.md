---
branch: feat/fleet-computer-use
---

### fleet-console
#### Changed
- On macOS, agents use apps in the background without moving your pointer or switching the active app. Fleet's own cursor appears only when an agent acts on an on-screen window. On the current Space, agents can read a minimized or hidden window, press supported controls, set field values and scroll without showing it. Typing, shortcuts, pasting, dragging and some clicks require the window to be on screen. On another Space, agents can take a screenshot of a window but can't control it. Computer Use requires the Fleet Console desktop app but no longer needs Codex or Cua Driver.
  ko: macOS에서 에이전트가 백그라운드에서 앱을 사용해도 내 포인터와 앞에 둔 앱은 그대로입니다. Fleet 전용 커서는 에이전트가 화면에 있는 창을 조작할 때만 나타납니다. 현재 스페이스에서는 최소화하거나 숨긴 창을 다시 띄우지 않고도 내용을 읽고, 지원되는 버튼을 누르고, 입력란의 값을 바꾸거나 스크롤할 수 있습니다. 타이핑, 단축키, 붙여넣기, 드래그와 일부 클릭은 창이 화면에 있어야 가능합니다. 다른 스페이스의 창은 스크린샷으로만 볼 수 있고 조작할 수 없습니다. 컴퓨터 사용에는 Fleet Console 데스크톱 앱이 필요하지만, Codex나 Cua Driver는 더 이상 필요하지 않습니다.
- With Screen Recording permission, the Computer Use preview can show a still image of the selected window even when it's minimized or hidden. On macOS 26, this also works for a window on another Space. Fleet refreshes the image about once a second, but only while the preview card is visible on the host or a remote device with full access is viewing the preview.
  ko: 화면 기록 권한이 있으면 에이전트가 고른 창이 최소화되거나 숨겨져도 컴퓨터 사용 미리보기에서 그 창을 정지 화면으로 볼 수 있습니다. macOS 26에서는 다른 스페이스의 창도 같은 방식으로 볼 수 있습니다. 이미지는 호스트에 미리보기 카드가 보이거나 전체 권한으로 연결된 원격 기기에서 미리보기를 보고 있을 때만 약 1초마다 갱신됩니다.
- The first time Computer Use needs Accessibility or Screen Recording, Fleet asks macOS for them, so the app appears in System Settings and you only need to turn it on. When both are missing, the Screen Recording prompt follows as soon as you turn on Accessibility. Permission messages name the app macOS actually checks and say what to do if the app isn't listed or doesn't reopen after Quit & Reopen.
  ko: 컴퓨터 사용에 손쉬운 사용·화면 기록 권한이 처음 필요해지면 Fleet이 macOS에 요청합니다. 앱이 시스템 설정 목록에 자동으로 올라오므로 켜기만 하면 됩니다. 둘 다 빠졌으면 손쉬운 사용을 켜는 즉시 화면 기록 요청이 이어서 뜹니다. 권한 안내는 macOS가 실제로 확인하는 앱 이름을 가리키고, 목록에 없거나 '종료 및 다시 열기' 뒤 다시 열리지 않을 때 할 일을 알려 줍니다.
#### Added
- Agents can file feedback tickets about Computer Use problems, saved in `~/.fleet/console/feedback/computer-use`.
  ko: 에이전트가 컴퓨터 사용 중 겪은 문제를 피드백 티켓으로 남기며, 티켓은 `~/.fleet/console/feedback/computer-use`에 저장됩니다.
#### Removed
- Computer Use is no longer available on Windows or Linux.
  ko: Windows와 Linux에서는 더 이상 컴퓨터 사용을 쓸 수 없습니다.
