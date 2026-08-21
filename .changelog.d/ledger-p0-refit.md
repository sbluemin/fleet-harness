---
branch: ledger-p0-refit
---

### fleet-console
#### Changed
- Ledger groups spend by backend, so you can see which provider the money went to before opening a single model row.
  ko: Ledger가 지출을 백엔드별로 묶어, 모델 행을 하나도 열지 않고도 어느 공급자로 돈이 갔는지 보여줍니다.

#### Fixed
- Ledger daily bars open that day's models in every window, not only Today, and a day with nothing to show is no longer drawn as a button that does nothing.
  ko: Ledger 일별 막대가 Today뿐 아니라 모든 기간에서 그 날의 모델을 엽니다. 보여줄 것이 없는 날은 더 이상 눌러도 반응 없는 버튼으로 그리지 않습니다.
- Ledger states in dollars when the total holds spend the daily chart cannot place on a day, instead of leaving the two silently disagreeing.
  ko: 일별 차트가 어느 날에도 놓지 못한 지출을 Ledger가 금액으로 밝힙니다. 합계와 차트가 말없이 어긋나던 동작을 바로잡았습니다.
