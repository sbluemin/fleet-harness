---
branch: console-release-updater
---

### fleet-cli
#### Changed
- `fleet update` now installs Fleet from GitHub Releases and checks the download against its published checksum before stopping a running Console; when it cannot install for you, it prints the release download commands instead of npm registry ones.
  ko: `fleet update`가 이제 GitHub Releases에서 Fleet를 받아 설치하며, 실행 중인 Console을 멈추기 전에 게시된 체크섬으로 내려받은 파일을 확인합니다. 직접 설치할 수 없을 때는 npm 레지스트리 대신 릴리스 다운로드 명령을 안내합니다.

### fleet-console
#### Changed
- Console updates now come from GitHub Releases: the update is downloaded and verified while Console keeps running, and a download or checksum failure leaves the current version untouched.
  ko: Console 업데이트를 이제 GitHub Releases에서 받습니다. Console이 계속 동작하는 동안 업데이트를 내려받아 확인하며, 다운로드나 체크섬 확인에 실패하면 현재 버전을 그대로 둡니다.
- In an older Fleet Desktop, Console points you to the Desktop update instead of updating itself in place.
  ko: 이전 Fleet Desktop에서는 Console이 스스로 업데이트하는 대신 Desktop 업데이트를 안내합니다.
