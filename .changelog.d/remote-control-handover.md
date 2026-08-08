---
branch: remote-control-handover
---

### fleet-console
#### Added
- When a device joins over an access link and takes control, the console now says so instead of changing silently. A full-screen notice names the device and offers to take control back; dismissing it leaves a bar that keeps the same control one click away.
  ko: 액세스 링크로 접속한 기기가 제어를 가져가면, 조용히 바뀌는 대신 화면이 그 사실을 알립니다. 전체 화면 안내가 어느 기기인지 밝히고 제어권 회수를 제안하며, 안내를 닫으면 같은 회수 버튼을 한 번에 누를 수 있는 막대가 남습니다.
- While another device is driving, the terminal keeps showing live output as read-only instead of going blank, so the owner can watch the work continue.
  ko: 다른 기기가 모는 동안에도 터미널이 비워지지 않고 살아 있는 출력을 읽기 전용으로 계속 보여 주므로, 주인은 작업이 이어지는 것을 지켜볼 수 있습니다.
- Only one device holds control at a time. A second full access link is refused while a device is connected, and the refused link stays usable for later.
  ko: 제어를 쥐는 기기는 한 번에 하나입니다. 한 기기가 접속해 있는 동안 두 번째 full 액세스 링크는 거절되며, 거절된 링크는 나중에 그대로 다시 쓸 수 있습니다.

#### Fixed
- Opening the same terminal from a second window no longer strands the first one on a dead screen showing an internal code. It now keeps the live output read-only and offers to take the terminal back.
  ko: 같은 터미널을 두 번째 창에서 열어도 먼저 있던 창이 내부 코드만 남은 죽은 화면에 갇히지 않습니다. 살아 있는 출력을 읽기 전용으로 계속 보여 주고 터미널을 되찾을 수 있게 합니다.

### fleet-desktop
#### Added
- Opening a console that another device already controls now explains that, instead of suggesting the access link was bad.
  ko: 다른 기기가 이미 제어 중인 Console을 열면, 액세스 링크가 잘못된 것처럼 안내하는 대신 그 사실을 그대로 설명합니다.
