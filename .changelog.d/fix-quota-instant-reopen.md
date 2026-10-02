---
branch: fix/quota-instant-reopen
---

### fleet-console
#### Changed
- Show each provider in the Quota panel as one summary line that expands in place, while keeping drag and keyboard reordering.
  ko: Quota 패널은 공급자마다 한 줄 요약으로 보이고 그 자리에서 펼쳐지며, 드래그와 키보드로 순서를 바꾸는 기능은 그대로입니다.

#### Fixed
- Reopening the Quota panel or reloading the page shows the last usage right away instead of a loading message, and refreshes it in the background.
  ko: Quota 패널을 다시 열거나 페이지를 새로고침해도 불러오는 중 문구 대신 마지막 사용량이 바로 보이고, 갱신은 백그라운드에서 진행됩니다.
