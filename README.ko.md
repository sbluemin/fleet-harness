<p align="center">
  <img src=".github/logo.png" width="420" alt="Fleet" />
</p>

<h1 align="center">모든 프런티어 코딩 에이전트.<br/>하나의 콘솔. 어떤 화면에서든.</h1>

<p align="center">
  <strong>Fleet는 코딩 에이전트들을 내 머신이 소유한 라이브 세션으로 실행하고</strong>,<br/>
  브라우저에서도, 네이티브 데스크톱 창에서도, 주머니 속 폰에서도 지휘하게 해 줍니다.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dotobokuri/fleet-console"><img src="https://img.shields.io/npm/v/@dotobokuri/fleet-console?color=c9a455" alt="npm"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-4aab8f" alt="License"></a>
  <br/>
  <a href="README.md">English</a> · <a href="README.ko.md">한국어</a>
</p>

<img src=".github/console-canvas.png" alt="Claude, Codex GPT-5.6, Cursor Grok 세션과 라이브 셸이 나란히 도는 Fleet Console" width="100%" />

<p align="center"><sub>하나의 Theater, 네 개의 라이브 Operation: Claude Fable 5, Codex GPT-5.6 Sol, Cursor Grok 4.5가 셸 옆에서 나란히 답하고 있습니다. 이 README의 모든 스크린샷은 이 저장소 위에서 Fleet를 실제로 돌려 캡처한 것입니다.</sub></p>

AI 코딩 에이전트 하나와 일하는 것은 워크플로우지만, 다섯과 일하는 것은 터미널 탭의 아수라장입니다 — 내려앉을 갑판을 주기 전까지는. Fleet는 모든 에이전트 세션을 **Operation**으로 만듭니다: 로컬 서버가 소유한 진짜 PTY이며, 무한 캔버스 위에 배치되고, 신뢰하는 어떤 기기에서든 관찰할 수 있습니다.

## 명령 하나로 시작

Node.js 20.19+ 그리고 `PATH`에 인증된 에이전트 CLI가 하나 이상 필요합니다.

```bash
npm install -g @dotobokuri/fleet-console

fleet console
```

<img src=".github/cli-console.png" alt="fleet CLI: 도움말 배너와 실제 fleet console 시작 출력" width="100%" />

모든 것이 내 머신에서 돕니다. 서버는 기본적으로 loopback에만 바인딩되고, 브라우저는 프로바이더 토큰을 받지 않으며, 원격 접속은 직접 켜기 전까지 꺼져 있습니다.

## 탭보다 오래 사는 에이전트

Operation의 주인은 브라우저가 아니라 로컬 Fleet Console 서버입니다. 탭을 닫아도 PTY는 계속 돌고 출력은 계속 버퍼링됩니다; 콘솔을 다시 열면 세션이 스크롤백을 재생하며 이어집니다. 조용해진 에이전트는 정해 둔 기준을 지나면 휴면으로 회수되고 클릭 한 번에 돌아옵니다. Operation 닫기는 몇 초간 되돌릴 수 있어 실수 클릭의 비용이 없습니다.

**Theater**는 프로젝트 폴더입니다. 일하는 폴더 수만큼 등록하세요 — 모든 패널, 세션, 도구가 활성 Theater를 따라갑니다.

## 런치 메뉴 하나 뒤의 모든 프런티어 모델

<img src=".github/console-launch-menu.png" alt="런치 메뉴: Claude, Codex, Cursor, Kimi, OpenCode 모델이 라이브 캔버스 위 우클릭 메뉴 하나에" width="100%" />

캔버스를 우클릭하고, 켜 둔 어떤 모델로든 Claude Code를 띄우세요 — 내장 Claude 모델이든, Console이 대신 쥔 자격증명 위를 달리는 게이트웨이 모델이든. 게이트웨이는 API 프록시가 아니라 로컬 Claude Code 엔드포인트입니다: 네이티브 에이전트 루프, 도구 문법, 인증이 그대로 보존되고, 비-Anthropic 자격증명은 에이전트 프로세스에 결코 들어가지 않습니다.

| 프로바이더 | 자격증명 | 모델 |
|---|---|---|
| **Codex** | ChatGPT 구독 | GPT-5.6 Sol · Terra · Luna, 각각 Fast 변형 |
| **Cursor** | Cursor 구독 | Auto · Composer 2.5 · Grok 4.5, Fast 변형 포함 |
| **Moonshot-Kimi** | API 키 | Kimi K3 1M · K3 256K |
| **OpenCode Go** | API 키 | MiniMax M3 · Qwen3.8 Max · DeepSeek V4 Flash / Pro · GLM-5.2 · Kimi K3 · MiMo V2.5 / Pro · HY3 · Grok 4.5 · GPT-5.6 Luna |

**설정 → AI Gateway**에서 원하는 로스터만 켜세요 — 켠 모델만 런치 메뉴와 Claude Code의 `/model` 피커에 나타납니다. 모델마다 LOW부터 XHIGH까지의 추론 강도 사다리가 붙고, 지원하는 모델은 자체 게이트 뒤에 정점 티어를 드러냅니다: **MAX**, 그리고 xhigh 강도와 상시 멀티 에이전트 오케스트레이션을 한 번에 켜는 **ULTRACODE**. 사용 한도 미터는 게이트웨이와 같은 리스크 판정을 읽으므로, 회복보다 빨리 소진되는 윈도우는 런이 멈추기 전에 위험으로 표시됩니다.

## 에이전트 하나에서 함대까지 늘어나는 캔버스

<img src=".github/console-war-room.png" alt="War Room 모드: 스테이지에 올라온 하나의 Operation, 상태 정렬 사이드바, 다음 대기열" width="100%" />

Operation은 무한 캔버스 위에 살고, 커맨드 밴드의 스위치가 배치를 얼마나 직접 할지 정합니다:

| 모드 | 하는 일 | 단축키 |
|---|---|---|
| **Cruise** | 패널을 원하는 자리에 직접 배치 — Station Keeping이 겹침을 막아 줌 | — |
| **Tactical** | 모든 패널을 그리드·열·행으로 한 번에 정렬 | <kbd>Alt</kbd>+<kbd>F</kbd> |
| **War Room** | Theater를 가로지르는 대기열에서 기다리는 패널을 한 건씩 | <kbd>Alt</kbd>+<kbd>T</kbd> |

여러 에이전트가 동시에 나를 기다릴 때는 War Room입니다: Operation 하나를 스테이지에 올리고 나머지는 다음 대기열에 세워 두며, 하나를 미뤄도 자리를 잃지 않습니다. <kbd>Alt</kbd>+<kbd>S</kbd>는 사이드바를 상태 — 작업 중, 대기 중, 유휴 — 로 정렬하고, 모든 Operation은 자신을 띄운 프로바이더의 글리프와 색을 답니다. <kbd>⌘</kbd>+<kbd>K</kbd>는 모든 Theater를 가로질러 Operation을 검색하고, <kbd>⌘</kbd>+<kbd>P</kbd>는 커맨드 팔레트를 엽니다.

## 터미널 옆의 프로젝트 전체

<img src=".github/console-repository.png" alt="Repository 패널: 활성 Theater의 커밋 그래프, 워크트리, 브랜치, 태그가 라이브 Operation 옆에" width="100%" />

Activity Rail에는 여덟 개의 내장 패널이 실려 있습니다 — **알림, Codex, Shell, 파일, 저장소, 스킬, 원장, 사용 한도** — 그리고 설치한 플러그인이 자기 패널을 더할 수 있습니다. 저장소 패널 하나만으로 활성 Theater의 히스토리, 작업 변경, 비교, 워크트리, 브랜치, 태그, 스태시를 감독 중인 Operation을 떠나지 않고 봅니다. 원장과 사용 한도는 토큰 지출과 프로바이더 쿼터를 같은 레일에 두어, 윈도우가 차오르는 것을 런이 멈추기 전에 알아차리게 합니다.

**Session Analyst**는 Operation 하나에 읽기 전용 지성을 더합니다: 무슨 일이 있었는지, 무엇을 리뷰해야 하는지, 핸드오프 브리핑을 부탁하세요 — 에이전트를 건드리지 않고 세션을 읽고, 긴 답은 근거가 인용된 렌더링 아티팩트로 발행하며, 지정한 CLI·모델·강도 위에서 돕니다.

## 주머니 속의 함대

<img src=".github/console-remote-pairing.png" alt="기기 연결: 15분 만료 QR 액세스 링크를 띄우고 폰의 페어링을 기다리는 콘솔" width="100%" />

**원격 접속**을 켜면 이 콘솔은 페어링한 기기가 — 오직 페어링한 기기만이 — 열 수 있습니다. QR 코드를 띄우고 Fleet Android 앱으로 스캔하면(링크 붙여넣기도 됩니다) 폰이 들어옵니다:

<img src=".github/mobile-android.png" alt="Android의 Fleet: 페어링된 콘솔 덱, Operations 목록, 그리고 폰 위에서 도는 Claude Code 세션 전체" width="100%" />

책상에 두고 온 그 Operation들 그대로입니다 — 가운데 폰이 목록을 보여주고, 오른쪽 폰은 스크롤백까지 완전한 Claude Code 세션입니다. 모바일 앱은 자기만의 편집증 교리를 지킵니다:

- **문은 페어링 하나뿐.** 원격 리스너는 세션 없이는 다른 무엇에도 답하지 않습니다. 액세스 링크는 한 번만 쓰이고, 안 쓰면 15분에 만료되며, 각각 정확히 한 기기를 페어링합니다 — 그러나 페어링 자체는 양쪽의 재시작을 견딥니다.
- **인증서는 핀으로 고정.** 모든 링크는 콘솔의 인증서 지문을 싣고 다닙니다; 다른 인증서로 답하는 콘솔은 그냥 열리지 않습니다. Android 셸은 WebView가 한 바이트라도 보기 전에 네이티브로 핀을 검증합니다.
- **조종간은 한 번에 하나.** 다른 기기가 제어권을 잡으면 나머지는 명시적인 커튼 뒤에서 관전으로 내려갑니다 — 하나의 PTY에 두 개의 키보드는 없습니다. 보기만 하고 입력은 못 하는 모니터링 전용 링크도 있습니다.
- **공개 도달은 이중 옵트인.** LAN 수신이 하나의 결정이라면, NAT 경로로 공개 호스트 이름을 광고하는 것은 별도로 확인까지 요구하는 또 하나의 결정입니다 — 라우터 규칙은 라우터가 실제로 묻는 필드 그대로 안내되고, 페어링 문에는 실패 예산이 걸려 노출된 엔드포인트를 공짜로 두들길 수 없습니다.

Android 앱은 이 저장소의 `runtime/fleet-mobile`에 있습니다(빌드 스크립트로 디버그 빌드); Fleet Console Desktop — 트레이 라이프사이클, 관리되는 런타임, 검증된 origin 위의 플랫폼 업데이트를 갖춘 얇은 네이티브 셸 — 은 [최신 GitHub 릴리스](https://github.com/sbluemin/fleet-harness/releases/latest)에서 설치합니다.

## 취향대로

라이트 또는 다크, 그리고 방 분위기에 맞는 다크 톤 — **Instrument**, **Maritime**, **Carbon**. UI와 터미널 타이포그래피는 머신에 설치된 폰트까지 독립적으로 설정됩니다. 콘솔은 크롬, 설정, 단축키, 내장 플러그인 전반에서 영어와 한국어를 말하며, 리로드 없이 즉시 전환됩니다. Fleet Wiki는 아키텍처 결정과 제품 히스토리를 실행과 같은 작업 공간에 보관해, 변경의 이유가 그것을 만든 대화보다 오래 살게 합니다.

> Fleet Console은 리서치 프리뷰입니다.

## 더 깊이

- [Fleet Development Reference](docs/fleet-development-reference.md) — 호스트 확장과 SDK 사용
- [Admiral Workflow Reference](docs/admiral-workflow-reference.md) — 오케스트레이션 아키텍처와 교리
- [Desktop 가이드](runtime/fleet-desktop/README.md) — 아티팩트, 업데이트 동작, 현재 한계
- [Changelog](CHANGELOG.ko.md) — 릴리스 히스토리

## License

MIT
