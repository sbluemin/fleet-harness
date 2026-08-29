---
branch: codex-plugin-routes-bundle
---

### fleet-console

#### Fixed
- Load Codex again in installed builds. The Codex panel reported that it could not read a Theater's Fleet Wiki data, because the plugin's server routes were left out of the packaged build when Codex moved out of the console core.
  ko: 설치본에서 Codex가 다시 열립니다. Codex가 콘솔 코어에서 플러그인으로 옮겨 갈 때 서버 라우트가 패키지에 담기지 않아, 패널이 Theater의 Fleet Wiki 데이터를 불러오지 못한다고 알렸습니다.
- Hide the terminal's provider title from browser payloads in installed builds, which had kept it visible because a plugin's redaction list did not survive packaging.
  ko: 설치본에서 터미널의 공급자 제목이 브라우저 페이로드에 그대로 나가던 것을 가립니다. 플러그인이 선언한 가림 목록이 패키징 과정에서 사라진 탓이었습니다.
