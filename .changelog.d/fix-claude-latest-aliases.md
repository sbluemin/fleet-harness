---
branch: fix-claude-latest-aliases
---

### fleet-console
#### Fixed
- With current Claude Code releases, AI Gateway again shows and routes Claude Opus and Sonnet as their latest versions instead of labeling Opus "Default", and Sonnet can now be picked in its standard or 1M context variant.
  ko: 최신 Claude Code에서도 AI Gateway가 Claude Opus와 Sonnet을 최신 버전으로 표시하고 라우팅하며 Opus를 "Default"로 표시하지 않고, Sonnet도 기본과 1M 컨텍스트 중에서 선택할 수 있습니다.

#### Changed
- AI Gateway delegation routing now puts remaining quota first and no longer weighs third-party benchmark scores; a provider whose allowance is nearly exhausted is skipped even when it heads your spend order, unless every provider is.
  ko: AI Gateway 위임 라우팅이 남은 쿼터를 가장 먼저 보고 외부 벤치마크 점수는 더 이상 반영하지 않습니다. 할당량이 거의 바닥난 프로바이더는 소진 순서의 맨 앞이어도 건너뛰며, 모든 프로바이더가 그런 경우에만 사용합니다.
