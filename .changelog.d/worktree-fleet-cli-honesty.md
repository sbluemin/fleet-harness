---
branch: worktree-fleet-cli-honesty
---

### fleet-cli
#### Changed
- `fleet --version`, `-v`, and `version` now print the Fleet package version and channel. Claude Code's version is still `fleet cli --version`.
  ko: `fleet --version`, `-v`, `version`이 Fleet 패키지 버전과 채널을 출력합니다. Claude Code 버전은 그대로 `fleet cli --version`입니다.
- `fleet auth login` and `logout` reject an unknown provider name instead of opening a picker.
  ko: `fleet auth login`과 `logout`이 알 수 없는 공급자 이름을 픽커로 넘기지 않고 거절합니다.
- `fleet doctor` reports the install, Claude Code on PATH, gateway auth, and Console health without changing anything. `fleet status` is the same as `fleet console status`.
  ko: `fleet doctor`가 설치본, PATH의 Claude Code, 게이트웨이 인증, Console 상태를 바꾸지 않고 보고합니다. `fleet status`는 `fleet console status`와 같습니다.
- `fleet update --check` reports whether a newer package is available without installing or stopping the Console.
  ko: `fleet update --check`가 설치하거나 Console을 내리지 않고 새 패키지 여부만 보고합니다.

### fleet-console
#### Fixed
- `fleet-console --help` now shows the installed version and channel instead of always saying `local`.
  ko: `fleet-console --help`가 항상 `local`이라고 하지 않고 설치된 버전과 채널을 보여 줍니다.
