---
branch: failure-vocabulary
---

### fleet-cli
#### Fixed
- A Console server that fails to start now names what stopped it and what to check, and a browser that never opened hands you the address instead of reporting success.
  ko: Console 서버가 시작되지 않으면 무엇이 막았고 무엇을 확인해야 하는지 말하고, 브라우저가 열리지 않았을 때는 성공했다고 하는 대신 주소를 건넵니다.

### fleet-console
#### Changed
- A brand new install no longer opens What's New. Its release backlog is not news to someone seeing the product for the first time, so the next release is the first one it announces.
  ko: 새로 설치한 Console은 더 이상 '새 소식'을 띄우지 않습니다. 처음 보는 사람에게 지난 릴리스 묶음은 새 소식이 아니므로, 다음 릴리스부터 알립니다.

#### Fixed
- Failures now say what happened, why, and what to do. A terminal that cannot connect, a folder that cannot become a Theater, and an Agent CLI that is missing or signed out each explain themselves instead of showing a status code or a machine name.
  ko: 실패가 무슨 일이 있었는지, 왜인지, 지금 무엇을 하면 되는지 말합니다. 연결되지 않는 터미널, Theater가 될 수 없는 폴더, 설치되지 않았거나 로그아웃된 Agent CLI가 각각 상태 코드나 기계 이름 대신 스스로를 설명합니다.
- Saving one setting no longer blocks another. Two settings changed in quick succession both persist, and a failed save reverts only its own field.
  ko: 한 설정을 저장하는 동안 다른 설정이 막히지 않습니다. 연달아 바꾼 두 설정이 모두 저장되고, 저장에 실패한 설정만 되돌아갑니다.
- Removing a skill, relaunching a dormant Shell, and opening a remote host now report a refusal instead of looking like nothing happened.
  ko: 스킬 제거, 휴면 Shell 재기동, 원격 호스트 열기가 거절당했을 때 아무 일도 없었던 것처럼 보이는 대신 그 사실을 알립니다.
- The terminal panel and the Skills list now follow the console language, and the Skills preview dialog, its tabs, and the Theater row are reachable with a screen reader.
  ko: 터미널 패널과 스킬 목록이 콘솔 언어를 따르고, 스킬 미리보기 창과 그 탭, Theater 행을 스크린 리더로 읽을 수 있습니다.
- A plugin that comes up without its panel now says so, instead of leaving an empty spot in the rail with no explanation.
  ko: 패널을 세우지 못한 플러그인이 그 사실을 알립니다. 레일에 설명 없는 빈자리만 남지 않습니다.

### fleet-desktop
#### Fixed
- A startup that cannot proceed now explains what stopped it and where the diagnostic log is, instead of quitting with no window and no message.
  ko: 시작할 수 없을 때 창도 메시지도 없이 종료하는 대신, 무엇이 막았고 진단 로그가 어디에 있는지 알립니다.
