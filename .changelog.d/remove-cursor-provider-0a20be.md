---
branch: remove-cursor-provider-0a20be
---

### fleet-console
#### Breaking Changes
- Removed the Cursor provider from AI Gateway, including saved model selections, usage, and diagnostics. Existing Cursor model sessions are no longer supported; start a new Operation with another provider. Ledger spending totals no longer include past Cursor usage.
  ko: AI Gateway의 Cursor 공급자와 저장된 모델 선택·사용량·진단 기능을 제거했습니다. 기존 Cursor 모델 세션은 더 이상 지원하지 않으므로 다른 공급자로 새 Operation을 시작하세요. Ledger 지출 합계에서도 과거 Cursor 사용분이 빠집니다.

### fleet-cli
#### Breaking Changes
- Removed Cursor support from `fleet gateway`, including its model selections and diagnostics option. Existing Cursor model invocations are no longer supported; use another Gateway provider.
  ko: `fleet gateway`에서 Cursor 지원과 해당 모델 선택·진단 옵션을 제거했습니다. 기존 Cursor 모델 호출은 더 이상 지원하지 않으므로 다른 Gateway 공급자를 사용하세요.
