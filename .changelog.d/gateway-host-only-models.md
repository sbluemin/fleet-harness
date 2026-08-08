---
branch: gateway-host-only-models
---

### fleet-console
#### Added
- AI Gateway models can now be marked host-only: the model stays selectable from Claude Code's `/model` picker and the launch dropdown, but Fleet registers no delegation identity for it and leaves it out of the `gateway_models` roster.
  ko: AI Gateway 모델을 이제 host-only로 표시할 수 있습니다. 모델은 Claude Code의 `/model` 피커와 실행 드롭다운에서 계속 선택할 수 있지만, Fleet는 해당 모델의 위임 정체성을 등록하지 않으며 `gateway_models` 로스터에서도 제외합니다.
