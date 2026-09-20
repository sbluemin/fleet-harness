---
branch: typesafe-systemone-signin
---

### fleet-console
#### Added
- Sign in to TypeSafe from Add model in AI Gateway settings so Console features can ask its Jev models for structured decisions. They are marked apart from chat models and never appear in the /model picker or the launch menu, and signing out only turns off the features that use them.
  ko: AI Gateway 설정의 모델 추가에서 TypeSafe에 로그인하면 Console 기능이 Jev 모델에 구조화된 판단을 물을 수 있습니다. 대화 모델과 구분해 표시되며 /model 픽커와 실행 메뉴에는 나타나지 않고, 로그아웃하면 그 키를 쓰는 기능만 멈춥니다.

### fleet-cli
#### Added
- `fleet gateway auth login typesafe` signs in to TypeSafe from the terminal, and `fleet doctor` now reports whether it is signed in.
  ko: `fleet gateway auth login typesafe`로 터미널에서 TypeSafe에 로그인할 수 있고, `fleet doctor`가 로그인 여부를 함께 알려줍니다.
