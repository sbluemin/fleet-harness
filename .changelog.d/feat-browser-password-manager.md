---
branch: feat/browser-password-manager
---

### fleet-console
#### Added
- Add a Browser section in Settings for managing saved Fleet Browser passwords and site save exceptions when running in Fleet Desktop.
  ko: Fleet Desktop에서 실행할 때 설정의 브라우저 항목에서 저장된 비밀번호와 저장 안 함 사이트 목록을 관리할 수 있습니다.

#### Changed
- Move the address and search suggestions setting from Advanced into the new Browser section.
  ko: 주소 및 검색어 제안 설정을 고급에서 새로운 브라우저 항목으로 이동했습니다.

#### Fixed
- Fix the error that prevented loading or saving address and search suggestion settings.
  ko: 주소 및 검색어 제안 설정을 저장하거나 불러오지 못하던 오류를 수정했습니다.

### fleet-desktop
#### Added
- Encrypt saved Fleet Browser passwords with OS safeStorage, offer save or update prompts on login, autofill credentials in both user and agent tabs, and require OS authentication when viewing or copying passwords.
  ko: OS safeStorage로 플릿 브라우저 비밀번호를 암호화 저장하고, 로그인 시 저장·업데이트 제안과 사용자·에이전트 탭 사이트별 자동완성, 비밀번호 보기·복사 시 OS 본인 인증을 제공합니다.
