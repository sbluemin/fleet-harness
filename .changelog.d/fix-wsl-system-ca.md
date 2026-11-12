---
branch: fix/wsl-system-ca
---

### fleet-desktop
#### Fixed
- Install and run a WSL Console trusting the distribution's system certificate store, as the Windows Console does, so certificate verification errors behind a TLS-inspecting proxy go away when its CA is installed in the distribution. Set `FLEET_CONSOLE_NO_SYSTEM_CA=1` to turn this off.
  ko: WSL 콘솔의 설치와 실행이 Windows 콘솔처럼 시스템 인증서 저장소(배포판의 저장소)를 신뢰합니다. TLS 검사 프록시의 CA가 배포판에 설치되어 있으면 인증서 검증 오류가 나지 않으며, `FLEET_CONSOLE_NO_SYSTEM_CA=1`로 끌 수 있습니다.
