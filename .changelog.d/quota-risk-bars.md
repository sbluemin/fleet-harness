---
branch: quota-risk-bars
---

### fleet-console
#### Changed
- Usage limit meters now read the same risk verdict the AI Gateway roster uses, so a window being spent faster than its clock refills shows as at-risk instead of waiting for the bar to look full. Each bar marks how far its reset cycle has run, shades the headroom the current burn rate is on track to consume, and says how long the window lasts at that pace. A help control at the top of the panel explains what the fill, the tick, and the hatching mean.
  ko: 사용 한도 미터가 AI Gateway 로스터와 같은 위험 판정을 읽습니다. 리셋 주기가 채워주는 속도보다 빠르게 소진 중인 창은 막대가 가득 차기를 기다리지 않고 위험 상태로 표시됩니다. 각 막대는 리셋 주기가 얼마나 지났는지 표시하고, 현재 소진 속도로 소모될 잔여분을 음영으로 보여주며, 그 속도라면 얼마나 버티는지 알려줍니다. 패널 상단의 도움말에서 채움·눈금·빗금이 각각 무엇인지 확인할 수 있습니다.
