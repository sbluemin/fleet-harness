---
branch: codex-prompt-cache-identity
---

### fleet-cli
#### Fixed
- Codex turns now reuse the prompt cache instead of paying for the whole conversation again. The gateway sent no session identity, so OpenAI routed each turn to a different machine and only about 4 in 10 turns found their own cached prefix; naming the session lifts that to better than 9 in 10 and cut the input tokens one measured run billed by 71 percent.
  ko: Codex 턴이 대화 전체를 다시 계산하지 않고 프롬프트 캐시를 재사용합니다. 게이트웨이가 세션 신원을 보내지 않아 OpenAI가 턴마다 다른 머신으로 보냈고 10턴 중 4턴 정도만 자기 캐시를 찾았는데, 세션을 알리자 10턴 중 9턴 이상으로 올라가며 실측 한 회차의 청구 입력 토큰이 71% 줄었습니다.

### fleet-console
#### Fixed
- Codex turns now reuse the prompt cache instead of paying for the whole conversation again. The gateway sent no session identity, so OpenAI routed each turn to a different machine and only about 4 in 10 turns found their own cached prefix; naming the session lifts that to better than 9 in 10 and cut the input tokens one measured run billed by 71 percent.
  ko: Codex 턴이 대화 전체를 다시 계산하지 않고 프롬프트 캐시를 재사용합니다. 게이트웨이가 세션 신원을 보내지 않아 OpenAI가 턴마다 다른 머신으로 보냈고 10턴 중 4턴 정도만 자기 캐시를 찾았는데, 세션을 알리자 10턴 중 9턴 이상으로 올라가며 실측 한 회차의 청구 입력 토큰이 71% 줄었습니다.
