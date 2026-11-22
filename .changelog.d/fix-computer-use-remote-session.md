---
branch: fix/computer-use-remote-session
---

### fleet-console
#### Changed
- Use Computer Use from a paired remote device with full access, and keep it running when a remote device connects. During Computer Use, the device with full access can show a still image of the window the agent selects, updated once per second. Monitoring-only devices remain read-only and don't receive previews. Fleet doesn't save preview images. Preview sharing is on by default and can be turned off only in Settings on the host Mac.
  ko: 전체 제어 권한으로 페어링한 원격 기기에서 컴퓨터 사용을 이용할 수 있고, 원격 기기가 연결되어도 진행 중인 작업이 멈추지 않습니다. 컴퓨터 사용 중에는 전체 권한 기기에서 에이전트가 고른 창 하나의 정지 화면을 1초마다 받아 볼 수 있습니다. 모니터링 전용 기기는 계속 읽기 전용이며 미리보기를 받지 않습니다. Fleet은 미리보기 이미지를 저장하지 않습니다. 미리보기 공유는 기본으로 켜져 있으며 호스트 Mac의 설정에서만 끌 수 있습니다.
