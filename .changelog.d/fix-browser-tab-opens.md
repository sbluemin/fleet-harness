---
branch: fix/browser-tab-opens
---

### fleet-console
#### Fixed
- Links that open in a new tab and `window.open` calls in Fleet Browser now open as new tabs next to the page instead of replacing it, so pages that wait for their opener keep working; Cmd/middle-click opens a background tab. `data:` addresses opened from a page no longer open.
  ko: Fleet 브라우저에서 새 탭으로 여는 링크와 `window.open` 이 원래 페이지를 대체하지 않고 새 탭으로 열려, 연 페이지를 기다리는 사이트도 그대로 동작합니다. Cmd·중간 클릭은 백그라운드 탭으로 열립니다. 페이지가 여는 `data:` 주소는 더 이상 열리지 않습니다.
