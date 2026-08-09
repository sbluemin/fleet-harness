---
branch: remote-access-auth-spine
---

### fleet-console
#### Added
- Remote access: serve the console on a chosen network interface over TLS and hand out access links that each carry a single-use credential and the console's certificate fingerprint. Settings shows the live listener, the fingerprint, every unused link and open session with its own revoke, and an identity rotation that cuts off every paired device at once. Turning remote access off closes the listener and ends every remote session immediately.
  ko: 원격 접속: 선택한 네트워크 인터페이스에 TLS로 Console을 열고, 각각 1회용 자격과 인증서 지문을 담은 액세스 링크를 발급합니다. 설정에서 현재 리스너와 지문, 사용되지 않은 링크와 열려 있는 세션을 개별 회수와 함께 보여주고, 연결된 모든 기기를 한 번에 끊는 신원 갱신을 제공합니다. 원격 접속을 끄면 리스너가 닫히고 모든 원격 세션이 즉시 끝납니다.
- Settings now keeps the other consoles this one can reach. Paste an access link and the console confirms the certificate before saving anything, then names, checks, opens, and forgets each host from one place. The host chip in the command band switches between them.
  ko: 설정이 이제 이 Console에서 건너갈 수 있는 다른 Console들을 보관합니다. 액세스 링크를 붙여넣으면 저장하기 전에 인증서를 먼저 확인하고, 이후로는 한 자리에서 각 호스트의 이름 변경·상태 확인·열기·삭제를 합니다. 커맨드 밴드의 호스트 칩으로 그 사이를 오갑니다.
- The host switcher lists the consoles already running on this machine, so reaching one takes no link at all. On Windows that includes a console running inside a WSL distribution, named by the distribution it lives in.
  ko: 호스트 스위처가 이 기계에서 이미 돌고 있는 콘솔들을 함께 보여 주므로, 그 콘솔에 가는 데는 링크가 필요 없습니다. Windows에서는 WSL 배포판 안에서 돌고 있는 콘솔도 그 배포판 이름과 함께 잡힙니다.
- Opening a remote listener's address in a browser now explains what an access link looks like and where to paste it, instead of answering with a bare authorization error.
  ko: 원격 리스너의 주소를 브라우저로 열면 인증 오류만 돌려주는 대신, 액세스 링크가 어떻게 생겼고 어디에 붙여넣는지 안내합니다.

#### Changed
- Access links are now a single `fleet://join?code=...` string. The address, the credential, the fingerprint, and the console's name travel inside one encoded envelope, so a pasted link no longer spells a private address out on screen. The envelope is encoding, not encryption: anyone holding the string can read the address back out and use the credential, so treat a link as a secret and send it over a channel you trust.
  ko: 액세스 링크가 이제 `fleet://join?code=...` 한 줄입니다. 주소·자격·지문·Console 이름이 인코딩된 봉투 하나에 함께 들어가므로, 붙여넣은 링크가 사설 주소를 화면에 그대로 적어 놓지 않습니다. 다만 이 봉투는 암호화가 아니라 인코딩입니다. 문자열을 가진 사람은 주소를 되읽고 자격을 쓸 수 있으므로, 링크는 비밀로 다루고 믿을 수 있는 경로로만 전달하세요.
- Console sessions now open through a single-use grant on both the loopback and remote listeners, and each listener judges the request that arrived on it: a grant issued for one never opens a session on the other.
  ko: Console 세션은 이제 루프백과 원격 양쪽에서 1회용 grant로 열리며, 각 리스너는 자기에게 도착한 요청만 판정합니다 — 한쪽에서 발급된 grant는 다른 쪽에서 세션을 열지 못합니다.

#### Fixed
- WebSocket upgrades now pass the same Host check as ordinary requests instead of reaching the upgrade handlers directly.
  ko: WebSocket 업그레이드가 업그레이드 핸들러로 바로 가지 않고, 일반 요청과 같은 Host 검사를 먼저 거칩니다.
- Segmented controls in Settings no longer stretch across their whole column. The Console port switch filled the row to hold two short buttons.
  ko: 설정의 분할 컨트롤이 열 전체로 늘어나지 않습니다. Console 포트 전환은 짧은 버튼 두 개를 담으려고 행 전체를 채우고 있었습니다.

### fleet-desktop
#### Added
- Fleet Desktop now opens `fleet://` access links. Selecting one hands it to the console already running in the window, which checks it and adds the host; Fleet Desktop shows no dialog of its own.
  ko: Fleet Desktop이 이제 `fleet://` 액세스 링크를 엽니다. 링크를 선택하면 창에서 실행 중인 Console에 넘기고, Console이 확인해 호스트로 추가합니다 — Fleet Desktop이 따로 대화상자를 띄우지 않습니다.
- Choosing a remote console inside the console now works in Fleet Desktop. It confirms the host's live certificate against the saved fingerprint before the browser engine ever contacts it, exchanges the one-time credential for a session, and only then moves the window. A host that answers with a different certificate does not open.
  ko: Console 안에서 원격 호스트를 고르는 동작이 Fleet Desktop에서 실제로 이어집니다. 브라우저 엔진이 그 호스트에 닿기 전에 저장된 지문으로 실제 인증서를 먼저 확인하고, 1회용 자격을 세션으로 바꾼 뒤에야 창을 옮깁니다. 다른 인증서로 응답하는 호스트는 열리지 않습니다.

#### Removed
- Remote runtimes over SSH. Fleet Desktop no longer installs or supervises a Node runtime and a console on a remote host over SSH; add that console in Settings with its access link instead. Connecting to a local console, including the managed one Fleet Desktop installs, is unchanged.
  ko: SSH 기반 원격 런타임을 제거했습니다. Fleet Desktop이 SSH로 원격 호스트에 Node 런타임과 Console을 설치하고 관리하지 않습니다 — 그 Console은 설정에서 액세스 링크로 추가하세요. Fleet Desktop이 설치하는 관리형 Console을 포함한 로컬 접속은 그대로입니다.
- The Connect to Runtime menu and tray entries. Which console to open is chosen in the console itself, so the native menu no longer carries a second copy of that list.
  ko: Connect to Runtime 메뉴와 트레이 항목을 제거했습니다. 어떤 Console을 열지는 Console 안에서 고르므로, 네이티브 메뉴가 같은 목록을 두 번째로 들고 있지 않습니다.
