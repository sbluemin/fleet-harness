---
branch: feat/gateway-1m-advertise
---

### fleet-console
#### Changed
- Each Codex model is one choice with a 500,000-token window, and Fast is a switch on that model instead of a second model or a context-window picker.
  ko: Codex 모델은 하나당 500,000토큰 창의 선택지 하나이고, Fast는 별도 모델이나 창 선택이 아니라 그 모델의 스위치입니다.
- Model lists no longer add 1M, Fast, or "(1M Context)" labels.
  ko: 모델 목록에 1M, Fast, "(1M Context)" 표기를 더하지 않습니다.
- Compact timing follows each model's real window and your compact point in Claude Code settings, instead of an environment variable.
  ko: 압축 시점은 환경 변수가 아니라, 모델의 실제 창과 설정한 압축 시점으로 Claude Code 설정에 들어갑니다.
#### Fixed
- A conversation that outgrows a model's real window can compact and continue instead of staying stuck.
  ko: 대화가 모델의 실제 창을 넘어도 막히지 않고 압축한 뒤 이어갈 수 있습니다.
