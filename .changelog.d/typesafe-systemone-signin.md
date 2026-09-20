---
branch: typesafe-systemone-signin
---

### fleet-console
#### Added
- Sign in to TypeSafe in AI Gateway settings so Console features can ask its Jev model for structured decisions. It offers no chat model, so signing out only turns off the features that use it.
  ko: AI Gateway 설정에서 TypeSafe에 로그인하면 Console 기능이 Jev 모델에 구조화된 판단을 물을 수 있습니다. 채팅 모델은 제공하지 않으므로, 로그아웃해도 그 키를 쓰는 기능만 멈춥니다.

### fleet-cli
#### Added
- `fleet gateway auth login typesafe` signs in to TypeSafe from the terminal, and `fleet doctor` now reports whether it is signed in.
  ko: `fleet gateway auth login typesafe`로 터미널에서 TypeSafe에 로그인할 수 있고, `fleet doctor`가 로그인 여부를 함께 알려줍니다.
