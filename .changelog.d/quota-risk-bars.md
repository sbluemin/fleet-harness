---
branch: quota-risk-bars
---

### fleet-console
#### Changed
- Usage limit meters now read the same risk verdict the AI Gateway roster uses, so a window being spent faster than its clock refills shows as at-risk instead of waiting for the bar to look full. Each bar marks how far its reset cycle has run, shades the headroom the current burn rate is on track to consume, and names when the window is projected to run dry.
  ko: 사용 한도 미터가 AI Gateway 로스터와 같은 위험 판정을 읽습니다. 리셋 주기가 채워주는 속도보다 빠르게 소진 중인 창은 막대가 가득 차기를 기다리지 않고 위험 상태로 표시됩니다. 각 막대는 리셋 주기가 얼마나 지났는지 표시하고, 현재 소진 속도로 소모될 잔여분을 음영으로 보여주며, 창이 언제 소진될지 예상 시점을 알려줍니다.
