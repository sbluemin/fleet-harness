---
branch: console-release-github
---

### fleet-cli
#### Changed
- Fleet is now installed and updated from GitHub Releases: install with `npm i -g https://github.com/sbluemin/fleet-harness/releases/latest/download/fleet-console.tgz`, and `fleet update` checks each download against its published checksum before stopping a running Console. Existing npm installs move over with their next update; use `fleet update` rather than `npm update -g`, which would bring back the older npm version.
  ko: 이제 Fleet는 GitHub Releases에서 설치하고 업데이트합니다. `npm i -g https://github.com/sbluemin/fleet-harness/releases/latest/download/fleet-console.tgz`로 설치하며, `fleet update`는 실행 중인 Console을 멈추기 전에 내려받은 파일을 게시된 체크섬으로 확인합니다. 기존 npm 설치본은 다음 업데이트 때 새 경로로 넘어옵니다. `npm update -g`는 npm에 남은 이전 버전으로 되돌리므로 `fleet update`를 사용하세요.

### fleet-console
#### Changed
- Console updates now come from GitHub Releases: the update is downloaded and verified while Console keeps running, and a download or checksum failure leaves the current version untouched.
  ko: Console 업데이트를 이제 GitHub Releases에서 받습니다. Console이 계속 동작하는 동안 업데이트를 내려받아 확인하며, 다운로드나 체크섬 확인에 실패하면 현재 버전을 그대로 둡니다.
- In an older Fleet Desktop, Console asks you to update Fleet Desktop first instead of updating itself in place.
  ko: 이전 Fleet Desktop에서는 Console이 스스로 업데이트하는 대신 Fleet Desktop을 먼저 업데이트하도록 안내합니다.

### fleet-desktop
#### Changed
- Fleet Desktop now installs and updates Console from GitHub Releases, checking each download against its published checksum before replacing the current version.
  ko: Fleet Desktop이 이제 GitHub Releases에서 Console을 설치하고 업데이트하며, 현재 버전을 바꾸기 전에 내려받은 파일을 게시된 체크섬으로 확인합니다.
