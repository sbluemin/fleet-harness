---
branch: integrate-cli-into-console
---

### fleet-cli
#### Breaking Changes
- `@dotobokuri/fleet-cli` no longer provides the `fleet` command. It is now version-matched migration metadata that only depends on `@dotobokuri/fleet-console`, and npm does not expose a dependency's command in the global prefix. Running `fleet update` from an existing install carries you across on its own, but installing or updating that package directly with npm leaves no `fleet` on your PATH; install `@dotobokuri/fleet-console` instead.
  ko: `@dotobokuri/fleet-cli`는 더 이상 `fleet` 명령을 제공하지 않습니다. 이제 `@dotobokuri/fleet-console`만 의존하는 같은 버전의 migration 메타데이터이며, npm은 의존 패키지의 명령을 전역 prefix에 노출하지 않습니다. 기존 설치에서 `fleet update`를 쓰면 알아서 넘어가지만, 그 패키지를 npm으로 직접 설치하거나 업데이트하면 PATH에 `fleet`가 남지 않습니다 — `@dotobokuri/fleet-console`을 설치하세요.

#### Changed
- Ship `fleet` from `@dotobokuri/fleet-console` with `fleet cli`, `fleet console`, and bare Claude Code passthrough.
  ko: `@dotobokuri/fleet-console`에서 `fleet`를 게시하며 `fleet cli`, `fleet console`, bare Claude Code 패스스루를 지원합니다.
- Update only `@dotobokuri/fleet-console`, stopping the local Console first when present.
  ko: `@dotobokuri/fleet-console`만 업데이트하며, 로컬 Console이 있으면 먼저 중지합니다.
- Publish a version-matched, bin-free `@dotobokuri/fleet-cli` migration package on each stable release so existing installs keep matching `@dotobokuri/fleet-console`.
  ko: 기존 `@dotobokuri/fleet-cli` 설치가 `@dotobokuri/fleet-console`과 계속 맞춰지도록, 안정 릴리스마다 같은 버전의 bin 없는 migration 패키지를 게시합니다.

### fleet-console
#### Changed
- Own both `fleet` and transitional `fleet-console` bins from one package.
  ko: 한 패키지에서 `fleet`와 과도기 `fleet-console` bin을 모두 소유합니다.
- Prefer `fleet console` in help while keeping transitional `fleet-console`.
  ko: help에서는 `fleet console`를 우선하고 과도기 `fleet-console`도 유지합니다.
