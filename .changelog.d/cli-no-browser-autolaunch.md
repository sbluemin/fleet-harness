---
branch: cli-no-browser-autolaunch
---

### fleet-cli
#### Changed
- `fleet console` and `fleet update` no longer launch a browser for you: the console starts and prints its address, and you open it wherever you want.
  ko: `fleet console`과 `fleet update`가 더 이상 브라우저를 대신 열지 않습니다. 콘솔이 켜지고 주소가 출력되면, 원하는 브라우저에서 직접 열면 됩니다.

### fleet-console
#### Changed
- Updating from inside the Console no longer pops open a browser window; if the console could not reclaim its old address, `fleet console status` shows where it moved.
  ko: Console 안에서 업데이트해도 브라우저 창이 새로 뜨지 않습니다. 옛 주소를 되찾지 못한 경우 `fleet console status`로 옮겨 간 주소를 확인할 수 있습니다.
