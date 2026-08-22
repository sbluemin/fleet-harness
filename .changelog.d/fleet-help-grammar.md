---
branch: fleet-help-grammar
---

### fleet-cli
#### Added
- Configure the AI Gateway from the terminal: `fleet gateway` opens an interactive screen for models, providers, spend priority, and policy, and `fleet gateway status`, `models`, and `set` report or change the same settings without prompts.
  ko: AI Gateway를 터미널에서 구성합니다. `fleet gateway`는 모델·공급자·소진 순서·정책을 다루는 인터랙티브 화면을 열고, `fleet gateway status`·`models`·`set`은 같은 설정을 프롬프트 없이 조회하거나 바꿉니다.
- Serve the AI Gateway on its own port with `fleet gateway serve`, so a client that speaks the Anthropic API can ride your subscriptions through `ANTHROPIC_BASE_URL`. It binds to loopback only and carries no authentication.
  ko: `fleet gateway serve`로 AI Gateway를 독립 포트에 띄웁니다. Anthropic API를 말하는 클라이언트가 `ANTHROPIC_BASE_URL`로 구독을 쓸 수 있습니다. 루프백에만 바인딩하며 인증은 없습니다.

#### Changed
- Group `fleet --help` into runtimes, their commands, settings, and maintenance. Each runtime lists its commands on one line and hands the detail to `fleet <runtime> --help`, and the new settings section names the files and environment variables that hold your configuration.
  ko: `fleet --help`를 런타임·런타임 명령·설정·유지보수로 나눕니다. 각 런타임은 명령을 한 줄로 보여주고 자세한 내용은 `fleet <runtime> --help`가 받으며, 새 설정 섹션은 구성을 담은 파일과 환경변수를 짚어 줍니다.
- Move provider authentication under the gateway as `fleet gateway auth`. The old `fleet auth` spelling still works and says where it went.
  ko: 공급자 인증을 게이트웨이 아래 `fleet gateway auth`로 옮깁니다. 기존 `fleet auth` 문법도 당분간 동작하며 어디로 옮겨졌는지 알려 줍니다.
