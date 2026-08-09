---
branch: feat-gateway-bench-evidence
---

### fleet-cli
#### Added
- Record third-party benchmark evidence (CursorBench) in the gateway model catalog and report it through the `gateway_models` roster; sessions rank judgment work by measured scores first, and models CursorBench has not measured fall back to the provider class as the only prior. Each gateway agent identity's description carries its benchmark score and token cost at its reasoning effort, with a class-based fit hint.
  ko: 게이트웨이 모델 카탈로그에 제3자 벤치마크 실측치(CursorBench)를 기록하고 `gateway_models` 로스터로 보고합니다. 세션은 판단 작업을 측정 점수 우선으로 배정하고, CursorBench가 측정하지 않은 모델은 공급자 등급을 유일한 사전 근거로 폴백합니다. 게이트웨이 에이전트 정체성 description에는 해당 추론 강도의 벤치마크 점수와 토큰 비용, 등급 기반 적합 힌트가 담깁니다.
- Add the opt-in `providerPriority` setting: an ordered provider list whose allowances runs spend first, overriding quota pressure forecasts until real failures are observed.
  ko: 옵트인 `providerPriority` 설정을 추가합니다. 지정한 공급자 순서대로 할당량을 먼저 소진하며, 실제 실패가 관측되기 전에는 할당량 압력 예보가 이 순서를 뒤집지 않습니다.

#### Removed
- Remove superseded OpenCode Go model generations (MiniMax M2.x, Qwen 3.5 to 3.7, GLM 5 and 5.1, Kimi K2.5 to K2.7) from the gateway catalog, keeping each lineup's current generation only.
  ko: OpenCode Go의 구세대 모델(MiniMax M2.x, Qwen 3.5~3.7, GLM 5·5.1, Kimi K2.5~K2.7)을 게이트웨이 카탈로그에서 제거하고 각 라인업의 현행 세대만 남깁니다.

### fleet-console
#### Added
- Record third-party benchmark evidence (CursorBench) in the gateway model catalog; Console-launched sessions rank judgment work by measured scores first, and each gateway agent identity description carries its benchmark figures.
  ko: 게이트웨이 모델 카탈로그에 제3자 벤치마크 실측치(CursorBench)를 기록합니다. Console에서 띄운 세션은 판단 작업을 측정 점수 우선으로 배정하고, 게이트웨이 에이전트 정체성 description에 벤치마크 수치가 담깁니다.
- Set the opt-in provider spend order in AI Gateway settings: click providers into a numbered order, or set a provider's place from the toggle beside its own name, which carries its rank and summarises what the order does in one line on hover or focus. Saves from other gateway controls preserve the order, and it weighs quota use only, never model quality.
  ko: AI Gateway 설정에서 옵트인 공급자 소진 순서를 정합니다. 공급자를 눌러 번호 순서를 만들거나, 공급자 이름 옆 토글에서 바로 자리를 정합니다 — 그 토글은 순위를 함께 표시하고 마우스를 올리거나 포커스를 주면 순서의 의미를 한 줄로 요약합니다. 다른 게이트웨이 설정을 저장해도 순서는 보존되며, 이 순서는 할당량 사용에만 작용하고 모델 품질 서열에는 영향이 없습니다.

#### Removed
- Remove superseded OpenCode Go model generations (MiniMax M2.x, Qwen 3.5 to 3.7, GLM 5 and 5.1, Kimi K2.5 to K2.7) from the AI Gateway roster, keeping each lineup's current generation only.
  ko: AI Gateway 로스터에서 OpenCode Go 구세대 모델(MiniMax M2.x, Qwen 3.5~3.7, GLM 5·5.1, Kimi K2.5~K2.7)을 제거하고 각 라인업의 현행 세대만 남깁니다.
