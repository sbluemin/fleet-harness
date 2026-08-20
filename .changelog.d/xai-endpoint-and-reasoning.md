---
branch: xai-endpoint-and-reasoning
---

### fleet-cli
#### Changed
- Send Grok turns to the endpoint the official Grok CLI uses. It is the pool an xAI subscription is built around, and it holds a steadier worst case than xAI's shared API, which refuses a turn outright when it is full.
  ko: Grok 턴을 공식 Grok CLI가 쓰는 엔드포인트로 보냅니다. xAI 구독이 실제로 기대는 경로이고, 가득 차면 턴을 즉시 거절하는 xAI 공용 API보다 최악의 경우가 완만합니다.
- Tell that endpoint the version of the Grok CLI actually installed on this machine, read from the installation itself. The gateway used to claim a version fixed in its own source, which only ages as that endpoint raises the version it accepts.
  ko: 그 엔드포인트에 이 기기에 실제로 설치된 Grok CLI 버전을 설치 정보에서 읽어 알립니다. 이전에는 게이트웨이 소스에 박힌 버전을 주장해, 그 엔드포인트가 요구 버전을 올릴수록 낡아질 수밖에 없었습니다.

#### Added
- Replay Grok's own prior reasoning across a tool round-trip, so the model no longer re-derives thinking it already did. Measured against xAI's wire, the following turn spends about half the reasoning tokens.
  ko: 도구 왕복을 사이에 두고 Grok이 앞서 한 추론을 그대로 되돌려 보내, 모델이 이미 한 생각을 다시 하지 않게 합니다. xAI 와이어 실측에서 다음 턴의 추론 토큰이 절반 수준으로 줄었습니다.

### fleet-console
#### Added
- Choose which endpoint Grok turns use, in Settings under AI Gateway next to the xAI models. Chat Proxy is the default and is what the official Grok CLI uses; Direct is xAI's own API. Both draw on the same subscription, and a turn always stays on the one you pick.
  ko: Grok 턴이 쓸 엔드포인트를 설정의 AI Gateway에서 xAI 모델 옆에 두고 고릅니다. 기본값 Chat Proxy는 공식 Grok CLI가 쓰는 경로이고, Direct는 xAI 자체 API입니다. 둘 다 같은 구독을 쓰며, 턴은 고른 쪽에서만 처리됩니다.
- Replay Grok's own prior reasoning across a tool round-trip, so the model no longer re-derives thinking it already did. Measured against xAI's wire, the following turn spends about half the reasoning tokens.
  ko: 도구 왕복을 사이에 두고 Grok이 앞서 한 추론을 그대로 되돌려 보내, 모델이 이미 한 생각을 다시 하지 않게 합니다. xAI 와이어 실측에서 다음 턴의 추론 토큰이 절반 수준으로 줄었습니다.

#### Changed
- Send Grok turns to the endpoint the official Grok CLI uses by default, and tell it the version of the Grok CLI actually installed on this machine. The gateway used to claim a version fixed in its own source, which only ages as that endpoint raises the version it accepts.
  ko: Grok 턴을 기본적으로 공식 Grok CLI가 쓰는 엔드포인트로 보내고, 이 기기에 실제로 설치된 Grok CLI 버전을 알립니다. 이전에는 게이트웨이 소스에 박힌 버전을 주장해, 그 엔드포인트가 요구 버전을 올릴수록 낡아질 수밖에 없었습니다.
