---
branch: fix/quota-instant-reopen
---

### fleet-console
#### Changed
- A collapsed Quota card shows a separate bar for each usage window, such as the session and the week, instead of only the most urgent one.
  ko: 접힌 Quota 카드가 가장 급한 창 하나만이 아니라 세션·주간처럼 창마다 막대를 따로 보여 줍니다.

#### Fixed
- Reopening the Quota panel or reloading the page shows the last usage right away instead of a loading message, and refreshes it in the background.
  ko: Quota 패널을 다시 열거나 페이지를 새로고침해도 불러오는 중 문구 대신 마지막 사용량이 바로 보이고, 갱신은 백그라운드에서 진행됩니다.
