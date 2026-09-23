---
branch: gateway-llm-stats-benchmarks
---

### fleet-console
#### Changed
- AI Gateway routing now compares nearly every Gateway model by LLM Stats benchmark scores, including overall, reasoning, coding, and agent indexes, instead of benchmarks that covered only two models.
  ko: AI Gateway 라우팅이 두 모델만 다루던 벤치마크 대신 LLM Stats 점수(종합·추론·코딩·에이전트)로 거의 모든 Gateway 모델을 비교합니다.
- Gateway model classes (flagship, standard, light) now follow LLM Stats score bands instead of each provider's own lineup claims, so some models change class and routing seats; models without scores keep the provider's positioning.
  ko: Gateway 모델 등급(flagship·standard·light)이 공급자의 라인업 주장 대신 LLM Stats 점수 구간을 따르므로 일부 모델의 등급과 라우팅 배정이 바뀝니다. 점수가 없는 모델은 공급자 기준을 유지합니다.
