---
branch: xai-endpoint-and-reasoning
---

### fleet-cli
#### Added
- Send a Grok turn to the endpoint the official Grok CLI uses when xAI's own API cannot admit it. A capacity refusal or an opening that never arrives now moves that turn across on its own, instead of ending it.
  ko: xAI 자체 API가 받아주지 못한 Grok 턴을 공식 Grok CLI가 쓰는 엔드포인트로 넘깁니다. 용량 거절이나 끝내 열리지 않는 응답이 턴을 끝내는 대신 스스로 그쪽으로 옮겨 갑니다.
- Replay Grok's own prior reasoning across a tool round-trip, so the model no longer re-derives thinking it already did. Measured against xAI's wire, the following turn spends about half the reasoning tokens.
  ko: 도구 왕복을 사이에 두고 Grok이 앞서 한 추론을 그대로 되돌려 보내, 모델이 이미 한 생각을 다시 하지 않게 합니다. xAI 와이어 실측에서 다음 턴의 추론 토큰이 절반 수준으로 줄었습니다.

#### Changed
- Tell the Grok CLI endpoint the version of the Grok CLI actually installed on this machine, read from the installation itself. The gateway used to claim a version fixed in its own source, which only ages as that endpoint raises the version it accepts.
  ko: Grok CLI 엔드포인트에 이 기기에 실제로 설치된 Grok CLI 버전을 설치 정보에서 읽어 알립니다. 이전에는 게이트웨이 소스에 박힌 버전을 주장해, 그 엔드포인트가 요구 버전을 올릴수록 낡아질 수밖에 없었습니다.

### fleet-console
#### Added
- Choose which xAI endpoint Grok turns open on, in Settings under AI Gateway. Direct is xAI's own API and stays the default; Grok CLI is the endpoint the official CLI uses and holds a steadier worst case. Both draw on the same subscription.
  ko: Grok 턴을 어느 xAI 엔드포인트로 열지 설정의 AI Gateway에서 고릅니다. Direct는 xAI 자체 API이자 기본값이고, Grok CLI는 공식 CLI가 쓰는 엔드포인트로 최악의 경우가 더 완만합니다. 둘 다 같은 구독을 씁니다.
- Send a Grok turn to the endpoint the official Grok CLI uses when xAI's own API cannot admit it. A capacity refusal or an opening that never arrives now moves that turn across on its own, instead of ending it.
  ko: xAI 자체 API가 받아주지 못한 Grok 턴을 공식 Grok CLI가 쓰는 엔드포인트로 넘깁니다. 용량 거절이나 끝내 열리지 않는 응답이 턴을 끝내는 대신 스스로 그쪽으로 옮겨 갑니다.
- Replay Grok's own prior reasoning across a tool round-trip, so the model no longer re-derives thinking it already did. Measured against xAI's wire, the following turn spends about half the reasoning tokens.
  ko: 도구 왕복을 사이에 두고 Grok이 앞서 한 추론을 그대로 되돌려 보내, 모델이 이미 한 생각을 다시 하지 않게 합니다. xAI 와이어 실측에서 다음 턴의 추론 토큰이 절반 수준으로 줄었습니다.

#### Changed
- Tell the Grok CLI endpoint the version of the Grok CLI actually installed on this machine, read from the installation itself. The gateway used to claim a version fixed in its own source, which only ages as that endpoint raises the version it accepts.
  ko: Grok CLI 엔드포인트에 이 기기에 실제로 설치된 Grok CLI 버전을 설치 정보에서 읽어 알립니다. 이전에는 게이트웨이 소스에 박힌 버전을 주장해, 그 엔드포인트가 요구 버전을 올릴수록 낡아질 수밖에 없었습니다.
