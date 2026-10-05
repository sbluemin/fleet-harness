---
branch: feat/claude-host-only
---

### fleet-console
#### Changed
- Claude models can be marked host-only in Settings > AI Gateway like any other model, so delegated runs are never assigned to them while they stay in every model picker. A host-only setting saved for Claude in an earlier version is cleared once on update; turn it on again if you still want it.
  ko: 이제 Settings > AI Gateway에서 Claude 모델도 다른 모델처럼 호스트 전용으로 지정할 수 있습니다. 호스트 전용 모델은 모든 모델 선택기에 그대로 남고 위임 실행에만 배정되지 않습니다. 예전 버전에서 Claude에 저장된 호스트 전용 값은 업데이트 때 한 번 해제되니, 계속 쓰려면 다시 켜 주세요.
- Delegation routing shows when no model can take delegated runs because every enabled model is host-only.
  ko: 켠 모델이 모두 호스트 전용이라 위임을 받을 모델이 없으면 위임 라우팅 설정에 그 사실이 표시됩니다.

### fleet-cli
#### Changed
- `fleet gateway models` reports Claude models with their context window and host-only state like other models, and `fleet gateway` lets you mark a Claude model host-only.
  ko: `fleet gateway models`가 Claude 모델도 다른 모델처럼 컨텍스트 창과 호스트 전용 여부를 함께 보여 주고, `fleet gateway`에서 Claude 모델을 호스트 전용으로 지정할 수 있습니다.
