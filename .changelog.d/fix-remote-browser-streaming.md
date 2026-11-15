---
branch: fix/remote-browser-streaming
---

### fleet-desktop
#### Fixed
- Keep Fleet Browser streaming to remote viewers when the host macOS window is minimized or closed with its close button, and reopen the shell from the Dock.
  ko: macOS에서 호스트 창을 최소화하거나 닫기 단추로 닫아도 원격 플릿 브라우저 스트리밍이 끊기지 않고 유지되며 Dock에서 창을 다시 열 수 있습니다.
- Fit the hosted Fleet Browser viewport to the remote viewer window only during active remote control, and restore the host pane size when control ends.
  ko: 원격에서 직접 조작할 때만 플릿 브라우저 화면 크기를 원격 창 비율에 맞추고, 조작이 끝나면 호스트 패널 크기로 되돌립니다.
