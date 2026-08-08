---
branch: gateway-agents-as-plugin-files
---

### fleet-cli
#### Changed
- Gateway model identities now carry the Fleet plugin scope. Select one as `fleet:<name>`, which is the spelling `gateway_models` reports, and the same rule the bundled Fleet skills already follow.
  ko: 게이트웨이 모델 정체성이 이제 Fleet 플러그인 스코프를 답니다. `fleet:<name>` 철자로 고르며, 이는 `gateway_models`가 보고하는 철자이자 함께 실리는 Fleet 스킬이 이미 따르던 규칙입니다.

#### Fixed
- A large enabled model roster no longer breaks the launch on Windows. Identity definitions moved off the command line into plugin files, so the number of models you enable no longer competes with the Windows command-line limit.
  ko: 활성 모델이 많아도 Windows에서 실행이 깨지지 않습니다. 정체성 정의가 명령줄에서 플러그인 파일로 옮겨져, 켜 둔 모델 수가 Windows 명령줄 한도와 더는 경합하지 않습니다.

### fleet-console
#### Changed
- Gateway model identities now carry the Fleet plugin scope. An Agent Operation selects one as `fleet:<name>`, which is the spelling `gateway_models` reports.
  ko: 게이트웨이 모델 정체성이 이제 Fleet 플러그인 스코프를 답니다. Agent Operation은 `fleet:<name>` 철자로 고르며, 이는 `gateway_models`가 보고하는 철자입니다.

#### Fixed
- A Claude (Gateway) Operation no longer fails to start on Windows when many gateway models are enabled. Identity definitions moved off the command line into plugin files, so the roster size no longer competes with the Windows command-line limit.
  ko: 게이트웨이 모델을 많이 켜 두어도 Windows에서 Claude (Gateway) Operation이 시작에 실패하지 않습니다. 정체성 정의가 명령줄에서 플러그인 파일로 옮겨져, 로스터 크기가 Windows 명령줄 한도와 더는 경합하지 않습니다.
