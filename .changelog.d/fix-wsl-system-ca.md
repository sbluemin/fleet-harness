---
branch: fix/wsl-system-ca
---

### fleet-desktop
#### Fixed
- Install and run a WSL Console behind a TLS-inspecting proxy without certificate verification errors, because it now trusts the distribution's system certificates. Set `FLEET_CONSOLE_NO_SYSTEM_CA=1` to turn this off.
  ko: TLS 검사 프록시 환경에서도 WSL 콘솔을 설치하고 실행할 때 인증서 검증 오류가 나지 않습니다. 배포판의 시스템 인증서를 신뢰하며, `FLEET_CONSOLE_NO_SYSTEM_CA=1`로 끌 수 있습니다.
