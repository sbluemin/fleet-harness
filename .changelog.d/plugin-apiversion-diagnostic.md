---
branch: plugin-apiversion-diagnostic
---

### fleet-console
#### Fixed
- External plugins with a missing or unsupported `apiVersion` no longer disappear silently; the skipped-plugin notice names each one and the `apiVersion` its `plugin.json` needs.
  ko: `apiVersion`이 없거나 지원되지 않는 외부 플러그인이 더 이상 조용히 사라지지 않습니다. 패널을 세우지 못한 플러그인 알림이 해당 플러그인과 `plugin.json`에 필요한 `apiVersion`을 알려 줍니다.
