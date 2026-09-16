### fleet-console
#### Fixed
- Gateway models no longer fail with "Unsupported Anthropic content block type: tool_addition" and retry endlessly when Claude Code adds an MCP tool mid-conversation.
  ko: Claude Code가 대화 도중 MCP 도구를 추가할 때 게이트웨이 모델이 "Unsupported Anthropic content block type: tool_addition" 오류로 무한 재시도하던 문제를 수정했습니다.
