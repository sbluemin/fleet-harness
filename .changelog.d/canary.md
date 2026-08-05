### fleet-core

#### Fixed
- [core-ai-gateway] A Codex-backed session no longer dies with `400 Unknown parameter: 'input[N].reasoning_content'`. Assistant reasoning is kept as replay metadata for the Chat Completions backends that require it, but it was also being written into the OpenAI Responses request body, where an unrecognized input property rejects the entire request, so every turn after the model's first thinking block failed. That metadata now stays provider-private on the Responses path.
  ko: Codex 백엔드 세션이 `400 Unknown parameter: 'input[N].reasoning_content'`로 죽지 않습니다. assistant 추론은 이를 요구하는 Chat Completions 백엔드용 재생 메타데이터로 보관하는데, OpenAI Responses 요청 본문에도 함께 실리고 있었고 이 경로는 알 수 없는 input 속성이 있으면 요청 전체를 거절하므로 모델이 처음 thinking을 낸 이후의 모든 턴이 실패했습니다. 이제 해당 메타데이터는 Responses 경로에서 provider 내부에만 남습니다.
