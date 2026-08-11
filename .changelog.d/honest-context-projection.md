---
branch: honest-context-projection
---

### fleet-cli
#### Changed
- Advertise `[1m]` only for gateway models with a real 1M-or-larger context window, while offset-mapping every model's usage so Claude Code compacts near that model's own context limit in mixed-model sessions.
  ko: 실제 컨텍스트 윈도우가 1M 이상인 게이트웨이 모델만 `[1m]`으로 표시하고, 혼합 모델 세션에서 각 모델이 자신의 컨텍스트 한계 근처에서 압축되도록 모든 모델의 사용량을 오프셋 매핑합니다.

### fleet-console
#### Changed
- Advertise `[1m]` only for gateway models with a real 1M-or-larger context window, while offset-mapping every model's usage so Claude Code compacts near that model's own context limit in mixed-model sessions.
  ko: 실제 컨텍스트 윈도우가 1M 이상인 게이트웨이 모델만 `[1m]`으로 표시하고, 혼합 모델 세션에서 각 모델이 자신의 컨텍스트 한계 근처에서 압축되도록 모든 모델의 사용량을 오프셋 매핑합니다.
