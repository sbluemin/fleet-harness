---
branch: browser-left-click-audit
---

### fleet-console
#### Fixed
- Operation Browser desktop resize follows the live pane again, so screenshots and click coordinates stop using a leftover mobile or tablet size.
  ko: Operation Browser에서 데스크톱 크기로 되돌리면 실제 패널 크기를 따르므로, 스크린샷과 클릭 좌표가 이전 모바일·태블릿 크기에 묶이지 않습니다.
#### Changed
- Agents can click Browser elements by reference and receive clearer feedback when a target cannot be clicked, without confusing input delivery with a successful page action.
  ko: 에이전트가 Browser 요소를 참조로 클릭하고 클릭할 수 없는 이유를 확인할 수 있으며, 입력 전달과 실제 페이지 동작 성공을 구분합니다.
