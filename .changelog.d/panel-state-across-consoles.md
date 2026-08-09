---
branch: panel-state-across-consoles
---

### fleet-console
#### Changed
- Fleet Console now counts "the first time each Theater opens in a session" against the browser tab session rather than the page load, so panels you expanded stay expanded when you move between the local console and a remote one, or reload the page. Opening a console for the first time in a tab still starts its existing panels minimized, and a freshly opened tab starts clean again.
  ko: Fleet Console이 "세션 중 각 Theater를 처음 여는 시점"을 페이지 로드가 아니라 브라우저 탭 세션 기준으로 셉니다. 그래서 로컬 콘솔과 원격 콘솔을 오가거나 페이지를 새로고침해도 펼쳐 둔 패널이 접히지 않습니다. 한 탭에서 처음 여는 콘솔은 여전히 기존 패널을 최소화한 채 시작하고, 새로 연 탭은 다시 깨끗하게 시작합니다.
