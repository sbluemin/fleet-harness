---
branch: fix/computer-use-remote-session
---

### fleet-console
#### Changed
- Use Computer Use from a paired remote device with full access, and keep it running when a remote device connects. While an agent uses the Mac, that device also sees the window the agent selected as a still image once per second; you can turn this off in Settings on the host. Monitoring devices remain read-only and don't receive previews.
  ko: 전체 제어 권한으로 페어링한 원격 기기에서 컴퓨터 사용을 이용할 수 있고, 원격 기기가 연결되어도 진행 중인 작업이 멈추지 않습니다. 에이전트가 Mac을 쓰는 동안 그 기기에서도 에이전트가 고른 창을 1초마다 정지 화면으로 볼 수 있으며, 호스트의 설정에서 끌 수 있습니다. 모니터링 기기는 계속 읽기 전용이며 미리보기를 받지 않습니다.
