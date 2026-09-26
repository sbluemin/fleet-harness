<p align="center">
  <img src=".github/logo.webp" width="96" alt="" />
</p>

<h1 align="center">Fleet</h1>

<p align="center">
  <b>여러 코딩 에이전트를 하나의 조용한 콘솔에서.</b><br/>
  Claude Code를 어떤 프런티어 모델로든 실행하고, 세션은 내 머신 위에 살려 둔 채<br/>
  브라우저·데스크톱 앱·폰 어디서든 함대 전체를 지휘하세요.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dotobokuri/fleet-console"><img src="https://img.shields.io/npm/v/@dotobokuri/fleet-console?style=flat-square&color=c9a455&label=npm" alt="npm 버전"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-5c9e92?style=flat-square" alt="MIT 라이선스"></a>
  <a href="https://sbluemin.github.io/fleet-harness/?lang=ko"><img src="https://img.shields.io/badge/site-sbluemin.github.io-2b2f38?style=flat-square" alt="프로젝트 사이트"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <b>한국어</b>
</p>

<br/>

<img src=".github/console-canvas.webp" alt="하나의 Theater에서 세 Operation이 도는 Fleet Console. Claude Fable과 Codex GPT-6-Sol은 터미널 보기로, Claude Opus는 채팅 보기로 실행 중" width="100%" />

<p align="center"><sub>Theater 하나, 모델이 다른 Operation 셋. Fable은 AI Gateway 구조를 추적하고, GPT-6-Sol은 릴리스 노트를 쓰고, Opus는 채팅 보기에서 저장소를 안내합니다. 이 저장소에서 실제로 캡처했습니다.</sub></p>

<br/>

## 시작하기

```bash
npm install -g @dotobokuri/fleet-console
fleet console
```

`fleet console`을 실행하면 로컬 서버가 뜨고 접속 주소가 출력됩니다. 그 주소를 아무 브라우저에서나 여세요. Node.js 20.19 이상, 그리고 설치와 로그인을 마친 Claude Code가 필요합니다. 인자 없이 `fleet`만 실행하면 같은 AI Gateway를 거치는 Claude Code가 터미널에서 바로 열립니다.

프로젝트 폴더를 **Theater**로 추가하고, 캔버스를 우클릭해 첫 **Operation**을 띄우세요.

## 탭을 닫아도 살아 있는 세션

Operation은 지금 보고 있는 페이지가 아니라 Fleet 서버가 소유하는 Claude Code 세션입니다. 탭을 닫든, 새로고침하든, 기기를 바꾸든 세션은 계속 돕니다. 돌아오면 지나간 출력이 그대로 다시 재생됩니다. Operation마다 터미널 보기와 채팅 보기 중에서 고를 수 있고, 세션 도중에도 바꿀 수 있습니다. 한동안 쉬던 세션은 휴면에 들어갔다가 클릭 한 번이면 깨어납니다. 방금 닫은 패널은 <kbd>⌘</kbd><kbd>Z</kbd>로 되살립니다.

## 런치 메뉴 하나 뒤의 모든 프런티어 모델

<img src=".github/console-launch-menu.webp" alt="런치 메뉴: Claude의 Fable, Opus, Sonnet 아래로 Codex GPT-6-Sol, xAI Grok-4.7 등 켜 둔 게이트웨이 모델" width="300" align="right" />

런치 메뉴에는 Claude의 모델이 먼저 오고, 그 아래로 **Settings → AI Gateway**에서 켠 게이트웨이 모델이 이어집니다. Claude Code의 `/model` 선택기에도 같은 목록이 나옵니다.

게이트웨이는 API 프록시가 아니라 로컬 Claude Code 엔드포인트입니다. Claude Code는 원래의 에이전트 루프와 도구를 그대로 씁니다. 다른 공급자의 자격증명은 콘솔 안에만 머물고 에이전트 프로세스에는 들어가지 않습니다. 로그인은 각 공급자 CLI에 이미 해 둔 것을 그대로 가져다 씁니다.

<br clear="right"/>

| 공급자 | 로그인 | 모델 |
|---|---|---|
| **Codex** | ChatGPT 구독 | GPT-6 Astra · Sol · Luna, GPT-5.6 Terra. 각각 272K·524K·1M 컨텍스트, 그리고 각각의 Fast 쌍둥이 |
| **Antigravity** | Google 구독 | Gemini 3.8 Flash · Gemini 3.1 Pro |
| **xAI** | Grok 구독 | Grok 4.7 · Grok 4.7 Fast · Grok Composer 2.5 Fast |
| **Muse Code** | Muse Code 구독 | Muse Spark 1.3 · Muse Spark 1.3 Contributor |
| **OpenCode Go** | API 키 | GLM-5.3 · GLM-5.3 Flash · DeepSeek V4 Pro · V4.1 Flash · V4 Flash Vision |

모델마다 추론 강도 단계가 따로 있습니다. 모든 행에는 **ULTRACODE**도 있어서, Claude Code를 xhigh 강도에 상시 멀티 에이전트 오케스트레이션까지 켠 채로 띄웁니다. **AI Gateway routing**을 켜면 서브에이전트와 워크플로 단계마다 게이트웨이 모델이 배정되고, 사용 한도를 거의 다 쓴 공급자는 건너뜁니다. **사용 한도** 미터도 같은 기준으로 판단하므로, 실행이 멈추기 전에 한도가 빠르게 차는 것을 알아챌 수 있습니다.

## 한 턴으로 끝나지 않는 일은 목표로

<img src=".github/console-objectives.webp" alt="계획 중인 목표: 브리핑, 두 개의 달성 기준, 지휘관이 제안한 docs-auditor 구성원, 첫 미션들, 그리고 개시 버튼" width="100%" />

**목표**(Objective)는 통째로 맡기는 일입니다. 원하는 결과와 완료를 판단할 기준을 적으면, 지휘관 세션이 끝까지 끌고 갑니다.

1. **브리핑**: 할 일을 적고 달성 기준을 붙입니다.
2. **계획**: 지휘관이 미션과 선행 조건, 필요한 구성원 세션을 짭니다. 이 단계에서는 아무것도 실행되지 않습니다.
3. **개시**: 지휘관이 미션을 직접 수행하거나 구성원에게 넘깁니다. 구성원은 저마다 역할과 모델, 강도가 다릅니다.
4. **인계**: 목표가 회고와 함께 돌아옵니다. 검토해서 완료하고, 후속 후보는 새 목표로 이어 갈 수 있습니다.

목표는 도구 막대에서 열거나 <kbd>⌘</kbd><kbd>⇧</kbd><kbd>Y</kbd>로 엽니다.

## 스스로 정렬되는 캔버스

Operation은 무한 캔버스 위에 놓입니다. 배치를 어디까지 직접 할지는 직접 고릅니다.

| | 하는 일 | 키 |
|---|---|---|
| **Cruise** | 패널을 원하는 곳에 둡니다. Station Keeping이 서로 겹치지 않게 간격을 지킵니다. | |
| **모두 정렬** | 모든 패널을 격자·열·행으로 한 번에 늘어놓습니다. 끄면 각자 원래 자리로 돌아갑니다. | <kbd>Alt</kbd><kbd>F</kbd> |
| **스냅 레이아웃** | 패널을 위쪽 가장자리로 끌면 반·삼분할·2×2 같은 자리에 붙습니다. 빈 칸에는 Snap Assist가 다른 패널을 제안합니다. | <kbd>⌘</kbd><kbd>Alt</kbd><kbd>←</kbd> <kbd>→</kbd> |
| **War Room** | 모든 Theater에서 응답을 기다리는 Operation을 하나씩 무대에 올립니다. | <kbd>Alt</kbd><kbd>T</kbd> |
| **Zen** | 크롬을 걷어 내고 Theater와 Operation만 담은 얇은 작업 표시줄을 남깁니다. | <kbd>⌘</kbd><kbd>Alt</kbd><kbd>Z</kbd> |

<kbd>⌘</kbd><kbd>K</kbd>로 어떤 Operation·파일·위키 문서로든 이동합니다. <kbd>⌘</kbd><kbd>P</kbd>는 명령 팔레트, <kbd>⌘</kbd><kbd>J</kbd>는 Quick Launch를 열고, <kbd>Alt</kbd><kbd>S</kbd>는 사이드바를 상태별로 묶습니다. 모든 단축키는 다시 지정할 수 있습니다. Windows와 Linux에서는 <kbd>⌘</kbd> 대신 <kbd>Ctrl</kbd>입니다.

## 세션 옆에 펼쳐지는 프로젝트

<img src=".github/console-repository.webp" alt="저장소 도구: 이 저장소의 커밋 그래프 옆에 브랜치·원격·태그·스태시" width="100%" />

도구 막대에서 여는 도구들은 활성 Theater를 따라갑니다.

- **저장소**: 히스토리, 변경 사항, 비교, 워크트리, 브랜치, 태그, 스태시.
- **파일**: 빠른 미리보기, 고정 폴더, git 상태 색을 갖춘 트리.
- **Shell**: 콘솔 전체가 함께 쓰는 터미널 하나(<kbd>Ctrl</kbd><kbd>`</kbd>).
- **Codex**: 프로젝트 위키. 실험 기능인 Cowork를 켜면 AI가 문서 수정안을 쓰고, 내가 적용하기 전까지는 아무것도 바뀌지 않습니다.
- **스킬**: 스킬을 둘러보고 설치합니다.
- **원장**과 **사용 한도**: 토큰 지출과 공급자별 한도.
- **목표**: 맡겨 둔 일들.

Operation 하나 옆에는 다음 동반 패널을 열 수 있습니다.

- **세션 분석가**(<kbd>Alt</kbd><kbd>A</kbd>)는 세션을 방해하지 않고 읽어서 무슨 일이 있었는지, 무엇을 검토해야 하는지, 어떻게 인계할지 답합니다.
- **Operation Browser**(<kbd>Alt</kbd><kbd>B</kbd>, 데스크톱 전용)는 내가 보는 탭을 에이전트가 그대로 조작하는 브라우저이며, 페이지에 주석을 달아 넘길 수 있습니다.

**Console Use**를 쓰면 에이전트가 콘솔 자체를 다룰 수 있고, **Computer Use**는 그 범위를 Mac 앱까지 넓힙니다. 둘 다 Operation마다 따로 허용하며, 요청은 패널 안에서 하나씩 승인합니다.

## 어떤 화면에서든

**데스크톱.** Fleet Console Desktop은 macOS·Windows·Linux용 얇은 네이티브 셸이며 [GitHub Releases](https://github.com/sbluemin/fleet-harness/releases/latest)에서 받을 수 있습니다. 콘솔 런타임을 스스로 관리하고, macOS와 Windows에서는 스스로 업데이트합니다.

**원격 접속.** 원격 접속은 실험 기능이며 기본으로 꺼져 있습니다. 켜더라도 콘솔은 페어링한 기기에만 열립니다.

- 접속 링크는 한 번만 쓸 수 있고 15분이 지나면 만료됩니다.
- 모든 링크는 콘솔의 인증서에 고정됩니다.
- 한 번에 한 기기만 조작하고, 나머지는 분명히 표시된 커튼 뒤에서 지켜봅니다.
- 입력 없이 지켜보기만 하는 모니터링 전용 링크도 만들 수 있습니다.
- 공인 인터넷으로 여는 것은 따로 한 번 더 켜야 합니다.

<img src=".github/mobile-android.webp" alt="Android의 Fleet: 페어링된 콘솔, Operations 목록, 폰에서 도는 Claude Code 세션" width="100%" />

**모바일.** 책상에 두고 온 Operation을 지나간 출력까지 그대로 폰에서 봅니다. Android와 iOS 앱은 테스터 배포 중이며, 소스는 [`runtime/fleet-mobile`](runtime/fleet-mobile)에 있습니다.

## 기본은 로컬

- 서버는 루프백에만 바인딩됩니다. 원격 접속을 켜기 전에는 다른 기기에서 닿지 않습니다.
- 공급자 자격증명은 콘솔 안에 머뭅니다. 브라우저가 받는 것은 한 번 쓰고 버리는 터미널 티켓뿐입니다.
- 세션과 설정, 기록은 내 머신의 `~/.fleet` 아래에 저장됩니다.

## 내 방식대로

테마는 **Instrument**, **Maritime**, **Carbon**(다크)과 **Whites**(라이트) 중에서 고릅니다. Liquid glass를 더하고, 인터페이스와 터미널 글꼴을 내 머신에 설치된 글꼴 중에서 고르고, 단축키를 모두 다시 지정할 수 있습니다. 콘솔은 한국어와 영어를 지원하며 새로고침 없이 바로 전환됩니다.

## 더 알아보기

- [Fleet Development Reference](docs/fleet-development-reference.md): 호스트 확장, 플러그인 제작, 격리된 개발용 콘솔 실행
- [Console Agent SDK](docs/console-agent-sdk.md): 플러그인이 기대는 계약
- [Admiral Workflow Reference](docs/admiral-workflow-reference.md): 오케스트레이션 아키텍처와 교리
- [Desktop 가이드](runtime/fleet-desktop/README.md): 배포물, 업데이트, 현재 한계
- [변경 이력](CHANGELOG.ko.md): 릴리스 기록

## 라이선스

[MIT](LICENSE)
