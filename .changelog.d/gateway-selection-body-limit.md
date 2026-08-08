---
branch: gateway-selection-body-limit
---

### fleet-cli
#### Fixed
- Turning a model off in the AI Gateway selection now also stops it being served. The model list already advertised only the models left on, but a request naming a model by its exact id was still answered against the full catalog and billed to that provider's subscription.
  ko: AI Gateway 선별에서 모델을 끄면 이제 서빙도 함께 멈춥니다. 모델 목록은 켜 둔 모델만 보여 주고 있었지만, 정확한 id를 지목한 요청은 여전히 전체 카탈로그에서 받아 그 공급자의 구독으로 청구됐습니다.

### fleet-console
#### Fixed
- Turning a model off in the AI Gateway roster now also stops it being served. Starting an Operation on a model left off was already refused, and the model list already hid it, but a request naming it by its exact id was still answered against the full catalog and billed to that provider's subscription.
  ko: AI Gateway 로스터에서 모델을 끄면 이제 서빙도 함께 멈춥니다. 꺼 둔 모델로 Operation을 시작하는 것은 이미 거절됐고 모델 목록에도 뜨지 않았지만, 정확한 id를 지목한 요청은 여전히 전체 카탈로그에서 받아 그 공급자의 구독으로 청구됐습니다.
