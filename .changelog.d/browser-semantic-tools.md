---
branch: browser-semantic-tools
---

### fleet-console
#### Changed
- Browser agents can target named controls, inspect only the state they need, and wait for explicit outcomes without repeating an action. Screenshots are now requested explicitly instead of being generated after every computer input.
  ko: Browser 에이전트가 이름으로 컨트롤을 지정하고 필요한 상태만 조회하며, 동작을 반복하지 않고 명시한 결과를 기다릴 수 있습니다. computer 입력마다 만들던 스크린샷은 이제 필요할 때 명시적으로 요청합니다.
- Browser captures wait for the native pane geometry and report actual image dimensions and coordinate conversion, with optional stale-geometry checks before coordinate input.
  ko: Browser 캡처가 실제 패널 크기 준비를 기다리고 이미지 크기와 좌표 변환 정보를 제공하며, 좌표 입력 전에 캡처 당시 크기와 달라졌는지 선택적으로 검사할 수 있습니다.
