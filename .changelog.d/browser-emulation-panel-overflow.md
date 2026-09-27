---
branch: browser-emulation-panel-overflow
---

### fleet-desktop
#### Fixed
- When an agent sets a Fleet Browser page larger than the open browser panel, the page now stays inside the panel instead of covering the rest of Console.
  ko: 에이전트가 Fleet Browser 페이지 크기를 열린 브라우저 패널보다 크게 정해도, 이제 페이지가 패널 안에 머물고 Console의 다른 화면을 덮지 않습니다.
- Fleet Browser screenshots of an agent-sized page no longer fail after the panel or window is resized, and a failed screenshot no longer shrinks the page to the panel size.
  ko: 에이전트가 크기를 정한 페이지는 패널이나 창 크기를 바꾼 뒤에도 Fleet Browser 스크린샷이 실패하지 않으며, 스크린샷이 실패해도 페이지가 패널 크기로 줄어들지 않습니다.
