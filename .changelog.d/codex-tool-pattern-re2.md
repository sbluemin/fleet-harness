---
branch: codex-tool-pattern-re2
---

### fleet-cli
#### Fixed
- Claude Code sessions on Codex (GPT) gateway models answer again. A tool whose JSON Schema carried a regular expression the Responses backend cannot compile, such as the lookahead and Unicode property patterns in Claude Code's Artifact tool, failed the entire request with a 400 before any reply arrived.
  ko: Codex(GPT) 게이트웨이 모델의 Claude Code 세션이 다시 답변합니다. Claude Code Artifact 도구의 lookahead·유니코드 속성 패턴처럼 Responses 백엔드가 컴파일하지 못하는 정규식이 도구 JSON Schema에 있으면, 답변이 오기 전에 요청 전체가 400으로 실패했습니다.

### fleet-console
#### Fixed
- Chat in an Operation running on a Codex (GPT) gateway model works again. A tool whose JSON Schema carried a regular expression the Responses backend cannot compile, such as the lookahead and Unicode property patterns in Claude Code's Artifact tool, failed the entire request with a 400, so the first message you sent never produced an answer.
  ko: Codex(GPT) 게이트웨이 모델로 도는 Operation의 채팅이 다시 동작합니다. Claude Code Artifact 도구의 lookahead·유니코드 속성 패턴처럼 Responses 백엔드가 컴파일하지 못하는 정규식이 도구 JSON Schema에 있으면 요청 전체가 400으로 실패해, 처음 보낸 메시지가 끝내 답변을 받지 못했습니다.
