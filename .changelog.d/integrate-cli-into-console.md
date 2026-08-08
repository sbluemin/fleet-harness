---
branch: integrate-cli-into-console
---

### fleet-cli
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
