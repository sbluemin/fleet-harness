---
branch: remote-access-auth-spine
---

### fleet-console
#### Added
- Remote access: serve the console on a chosen network interface over TLS and hand out an access link that carries a single-use credential and the console's certificate fingerprint. Settings shows the live listener, the fingerprint, and what the link grants; turning it off closes the listener and ends every remote session at once.
  ko: 원격 접속: 선택한 네트워크 인터페이스에 TLS로 Console을 열고, 1회용 자격과 인증서 지문을 함께 담은 액세스 링크를 발급합니다. 설정에서 현재 리스너와 지문, 링크가 여는 권한을 보여주며, 끄면 리스너가 닫히고 모든 원격 세션이 즉시 끝납니다.

#### Changed
- Console sessions now open through a single-use grant on both the loopback and remote listeners, and each listener judges the request that arrived on it: a grant issued for one never opens a session on the other.
  ko: Console 세션은 이제 루프백과 원격 양쪽에서 1회용 grant로 열리며, 각 리스너는 자기에게 도착한 요청만 판정합니다 — 한쪽에서 발급된 grant는 다른 쪽에서 세션을 열지 못합니다.

#### Fixed
- WebSocket upgrades now pass the same Host check as ordinary requests instead of reaching the upgrade handlers directly.
  ko: WebSocket 업그레이드가 업그레이드 핸들러로 바로 가지 않고, 일반 요청과 같은 Host 검사를 먼저 거칩니다.

### fleet-desktop
#### Added
- Connect to a console on another machine by pasting its access link. Fleet Desktop confirms the console's certificate against the fingerprint the link carries before it opens anything, exchanges the credential for a session in the main process, and only then hands the window to that console.
  ko: 다른 기기의 Console에 액세스 링크를 붙여넣어 접속합니다. Fleet Desktop은 무엇을 열기 전에 링크가 실은 지문으로 Console 인증서를 확인하고, 메인 프로세스에서 자격을 세션으로 바꾼 뒤에야 창을 그 Console로 넘깁니다.

#### Removed
- Remote runtimes over SSH. Fleet Desktop no longer installs or supervises a Node runtime and a console on a remote host over SSH; connect to a console that is already running there with its access link instead. Connecting to a local console, including the managed one Fleet Desktop installs, is unchanged.
  ko: SSH 기반 원격 런타임을 제거했습니다. Fleet Desktop이 SSH로 원격 호스트에 Node 런타임과 Console을 설치하고 관리하지 않습니다 — 그곳에서 이미 실행 중인 Console에 액세스 링크로 접속하세요. Fleet Desktop이 설치하는 관리형 Console을 포함한 로컬 접속은 그대로입니다.
