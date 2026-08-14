---
branch: xai-agent-loop-optimization
---

### fleet-cli
#### Changed
- Reduced repeated Grok 4.6 tool-schema uploads during tool-search loops while preserving selected and continuation-referenced tools.
  ko: 선택된 도구와 연속 호출에서 참조된 도구를 유지하면서 도구 검색 루프에서 반복되는 Grok 4.6 도구 스키마 전송을 줄였습니다.

### fleet-console
#### Changed
- Reduced repeated Grok 4.6 tool-schema uploads during gateway Operations that use tool search while preserving selected and continuation-referenced tools.
  ko: 선택된 도구와 연속 호출에서 참조된 도구를 유지하면서 도구 검색을 사용하는 게이트웨이 Operation에서 반복되는 Grok 4.6 도구 스키마 전송을 줄였습니다.
