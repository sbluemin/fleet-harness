---
branch: panel-state-across-consoles
---

### fleet-console
#### Changed
- Fleet Console now comes back the way you left it when you move between the local console and a remote one, or reload the page. The canvas mode you were in returns, whether that is Cruise, Tactical, or War Room, with Tactical remembered per Theater and War Room across all of them; panels you expanded stay expanded, because "the first time each Theater opens in a session" is counted against the browser tab session rather than the page load. A newly opened tab still starts in Cruise with its existing panels minimized, and the queue judgments made inside War Room stay tied to that visit rather than returning with the mode.
  ko: 로컬 콘솔과 원격 콘솔을 오가거나 페이지를 새로고침해도 Fleet Console이 떠날 때 모습으로 돌아옵니다. 있던 캔버스 모드(Cruise·Tactical·War Room)가 그대로 복귀하며 Tactical은 Theater별로, War Room은 전체를 아울러 기억합니다. "세션 중 각 Theater를 처음 여는 시점"을 페이지 로드가 아니라 브라우저 탭 세션 기준으로 세므로 펼쳐 둔 패널도 접히지 않습니다. 새로 연 탭은 여전히 Cruise로, 기존 패널은 최소화한 채 시작하고, War Room 안에서 내린 큐 판정은 모드와 함께 돌아오지 않고 그 방문에만 남습니다.
