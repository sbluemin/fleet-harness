---
branch: quota-risk-bars
---

### fleet-console
#### Changed
- Usage limit meters now read the same risk verdict the AI Gateway roster uses, so a window being spent faster than its clock refills shows as at-risk instead of waiting for the bar to look full. Each bar marks how far its reset cycle has run, shades the headroom the current burn rate is on track to consume, and says how long the window lasts at that pace. The panel now keeps its update time, refresh, and a help control on a bar that stays put as you scroll; the help explains what the fill, the tick, and the hatching mean, and where the readings come from.
  ko: 사용 한도 미터가 AI Gateway 로스터와 같은 위험 판정을 읽습니다. 리셋 주기가 채워주는 속도보다 빠르게 소진 중인 창은 막대가 가득 차기를 기다리지 않고 위험 상태로 표시됩니다. 각 막대는 리셋 주기가 얼마나 지났는지 표시하고, 현재 소진 속도로 소모될 잔여분을 음영으로 보여주며, 그 속도라면 얼마나 버티는지 알려줍니다. 갱신 시각·새로고침·도움말은 스크롤해도 자리를 지키는 하단 바에 모였고, 도움말에서 채움·눈금·빗금의 뜻과 수치의 출처를 확인할 수 있습니다.
