---
branch: grep-glob-restore
---

### fleet-cli
#### Changed
- Agents now search with the dedicated Grep and Glob tools instead of shell commands alone.
  ko: 에이전트가 셸 명령에만 기대지 않고 Grep, Glob 도구로 직접 검색합니다.

#### Fixed
- Stop a Grok answer from ending in the raw `<|eos|>` marker the model emits as text.
  ko: Grok 답변 끝에 모델이 텍스트로 흘려보내는 `<|eos|>` 원본 마커가 붙지 않습니다.

### fleet-console
#### Changed
- Agents now search with the dedicated Grep and Glob tools instead of shell commands alone.
  ko: 에이전트가 셸 명령에만 기대지 않고 Grep, Glob 도구로 직접 검색합니다.

#### Fixed
- Stop a Grok answer from ending in the raw `<|eos|>` marker the model emits as text.
  ko: Grok 답변 끝에 모델이 텍스트로 흘려보내는 `<|eos|>` 원본 마커가 붙지 않습니다.
