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
  <a href="https://github.com/sbluemin/fleet-harness/releases/latest"><img src="https://img.shields.io/github/v/release/sbluemin/fleet-harness?style=flat-square&color=c9a455&label=release" alt="최신 릴리스"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-5c9e92?style=flat-square" alt="MIT 라이선스"></a>
  <a href="https://sbluemin.github.io/fleet-harness/?lang=ko"><img src="https://img.shields.io/badge/site-sbluemin.github.io-2b2f38?style=flat-square" alt="프로젝트 사이트"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <b>한국어</b>
</p>

<br/>

<img src=".github/console-conversation.webp" alt="세 열 배치의 Fleet Console. 사이드바에 대화 네 개, 가운데에 Repository tour 대화, 오른쪽 세부 열에 파일 도구" width="100%" />

<p align="center"><sub>Theater 하나, 모델이 다른 대화 넷. 가운데에는 저장소 안내 대화가, 그 옆에는 파일 도구가 열려 있습니다. 이 저장소의 사본에서 시연용 세션으로 캡처했습니다.</sub></p>

<br/>

## 시작하기

```bash
npm i -g https://github.com/sbluemin/fleet-harness/releases/latest/download/fleet-console.tgz
fleet console
```

`fleet console`을 실행하면 로컬 서버가 뜨고 접속 주소가 출력됩니다. 그 주소를 아무 브라우저에서나 여세요. Node.js 20.19 이상, 그리고 설치와 로그인을 마친 Claude Code가 필요합니다. 인자 없이 `fleet`만 실행하면 같은 AI Gateway를 거치는 Claude Code가 터미널에서 바로 열립니다.

업데이트는 Console 화면이나 `fleet update`로 하세요. `npm update -g`는 npm에 남은 옛 버전으로 되돌립니다.

사이드바 맨 위의 **+**를 누르면 새 세션 화면이 열립니다. 거기서 **Theater 추가…**로 프로젝트 폴더를 **Theater**로 더하고, 모델과 강도를 고른 뒤 첫 메시지를 보내세요. <kbd>⌘</kbd><kbd>J</kbd>로도 시작할 수 있습니다.

## 탭을 닫아도 살아 있는 세션

대화 하나하나는 지금 보고 있는 페이지가 아니라 Fleet 서버가 소유하는 Claude Code 세션입니다. 탭을 닫든, 새로고침하든, 기기를 바꾸든 세션은 계속 돕니다. 돌아오면 대화가 그대로 남아 있습니다. 대화는 기본으로 채팅으로 보이고, 같은 세션을 전체 터미널로 다시 열 수도 있습니다. Console이 다시 시작된 뒤처럼 끝난 세션은 **재개**로 되살립니다. 방금 닫은 패널은 <kbd>⌘</kbd><kbd>Z</kbd>로 다시 엽니다.

## 런치 메뉴 하나 뒤의 모든 프런티어 모델

<img src=".github/console-launch-menu.webp" alt="런치 메뉴: Claude의 Fable, Opus, Sonnet 아래로 Codex GPT-6.1-Sol, xAI Grok-4.7, Antigravity Gemini-3.1-Pro 등 켜 둔 게이트웨이 모델" width="300" align="right" />

런치 메뉴에는 Claude의 모델이 먼저 오고, 그 아래로 **Settings → AI Gateway**에서 켠 게이트웨이 모델이 이어집니다. Claude Code의 `/model` 선택기에도 같은 목록이 나옵니다.

게이트웨이는 API 프록시가 아니라 로컬 Claude Code 엔드포인트입니다. Claude Code는 원래의 에이전트 루프와 도구를 그대로 씁니다. 다른 공급자의 자격증명은 콘솔 안에만 머물고 에이전트 프로세스에는 들어가지 않습니다. 로그인은 각 공급자 CLI에 이미 해 둔 것을 그대로 가져다 씁니다.

<br clear="right"/>

| 공급자 | 로그인 | 모델 |
|---|---|---|
| **Codex** | ChatGPT 구독 | GPT-6.1 Sol, GPT-6 Astra · Sol · Luna, GPT-5.6 Terra. 각각 272K·524K·1M 컨텍스트, 그리고 각각의 Fast 쌍둥이 |
| **Antigravity** | Google 구독 | Gemini 3.8 Flash · Gemini 3.1 Pro |
| **xAI** | Grok 구독 | Grok 4.7 · Grok 4.7 Fast · Grok Composer 2.5 Fast |
| **Cursor** | Cursor 구독 | Grok 4.7 · Grok 4.7 Fast. 각각 256K·500K 컨텍스트 · Muse Spark 1.3. 300K·1M 컨텍스트 |
| **Muse Code** | Muse Code 구독 | Muse Spark 1.3 · Muse Spark 1.3 Contributor |

모델마다 추론 강도 단계가 따로 있습니다. 모든 행에는 **ULTRACODE**도 있어서, Claude Code를 xhigh 강도에 상시 멀티 에이전트 오케스트레이션까지 켠 채로 띄웁니다. **AI Gateway routing**을 켜면 서브에이전트와 워크플로 단계마다 게이트웨이 모델이 배정되고, 사용 한도를 거의 다 쓴 공급자는 건너뜁니다. 오른쪽 위의 사용량 미터도 같은 기준으로 판단하므로, 실행이 멈추기 전에 한도가 빠르게 차는 것을 알아챌 수 있습니다.

## 한 턴으로 끝나지 않는 일은 목표로

<img src=".github/console-objectives.webp" alt="계획 중인 목표: 그룹 대화에 지휘관의 답과 합류한 구성원 둘, 오른쪽 세부 열에 브리프와 승인을 기다리는 달성 기준 제안 둘" width="100%" />

모든 대화는 **지휘관**(Commander)이 이끕니다. 그냥 말을 걸어도 되고, 요청을 통째로 맡기는 일인 **목표**(Objective)로 바꿀 수도 있습니다.

1. **계획**: 원하는 일을 적고 **구상**을 누릅니다. 지휘관이 미션과 선행 조건, 필요한 구성원 세션을 짜고 달성 기준을 제안합니다. 이 단계에서는 아무것도 실행되지 않습니다.
2. **승인**: 제안된 기준을 하나씩 승인하거나 거절하거나 주석을 달고, 내 기준을 더할 수도 있습니다.
3. **개시**: 지휘관이 미션을 직접 수행하거나 구성원에게 넘깁니다. 구성원은 저마다 역할과 모델, 강도가 다릅니다. 지휘관과 구성원은 그룹 대화 하나를 함께 쓰며, 여기서 구성원을 @로 부르거나 일을 멈추거나 그들이 묻는 결정에 답합니다.
4. **인계**: 목표가 회고와 함께 돌아옵니다. 검토해서 완료하고, 후속 후보는 새 목표로 이어 갈 수 있습니다.

목표의 브리프와 기준, 구성원, 미션 그래프, 결과는 대화 옆 세부 열에 있습니다. 결정에 답하고 개시하고 완료하는 일은 폰에서도 할 수 있습니다.

## Theater는 사령관에게

Theater마다 **사령관**(Commodore)이 있습니다. Theater의 목표를 스스로 굴리는 조정자입니다. Theater 머리의 사령관 표시를 눌러 자율 운영을 켜면, 사령관이 제목과 브리프로 목표를 만들고, 계획은 각 지휘관에게 맡기고, 목표를 개시하고 검토하며, 지휘관의 질문에 답합니다. 사령관이 정하지 말아야 할 결정은 **내 결정** 아래에서 나를 기다리고, 사령관이 나에게 직접 묻기도 합니다. Theater 머리를 누르면 **Theater Inbox**가 열려 사령관의 로그와 지시, 설정을 Theater 시스템 프롬프트와 함께 볼 수 있습니다. 목표 하나만 사이드바 행에서 사령관에게 넘길 수 있고, 사령관이 Theater를 굴리는 동안에는 Quick Launch에서 `@`로 말을 걸 수 있습니다.

## 한 번에 대화 하나

데스크톱 화면은 대화입니다. 사이드바에 Theater마다 대화가 늘어서고, 가운데는 지금 보고 있는 대화이며, 오른쪽 세부 열은 그 대화의 목표나 내가 연 도구를 보여 줍니다. <kbd>Alt</kbd><kbd>←</kbd>와 <kbd>Alt</kbd><kbd>→</kbd>로 활성 Theater의 대화를 오갑니다. 세션마다 하는 일을 몸짓으로 보여 주는 아바타가 있고, 캐릭터와 색을 바꿀 수 있습니다.

<kbd>⌘</kbd><kbd>K</kbd>로 어떤 대화·파일·위키 문서로든 이동합니다. <kbd>⌘</kbd><kbd>P</kbd>는 명령 팔레트, <kbd>⌘</kbd><kbd>J</kbd>는 Quick Launch를 열고, <kbd>⌘</kbd><kbd>⇧</kbd><kbd>Y</kbd>는 목표를 여닫고, <kbd>Alt</kbd><kbd>S</kbd>는 사이드바를 상태별로 묶습니다. 모든 단축키는 다시 지정할 수 있습니다. Windows와 Linux에서는 <kbd>⌘</kbd> 대신 <kbd>Ctrl</kbd>입니다.

## 대화 옆에 펼쳐지는 프로젝트

<img src=".github/console-repository.webp" alt="저장소 도구: 이 저장소의 커밋 그래프 옆에 워크트리·브랜치·원격·태그·스태시" width="100%" />

대화마다 위에 놓인 도구 막대가 그 대화의 Theater에 맞는 도구를 엽니다.

- **저장소**: 히스토리, 변경 사항, 비교, 워크트리, 브랜치, 태그, 스태시.
- **파일**: 빠른 미리보기, 고정 폴더, git 상태 색을 갖춘 트리.
- **Shell**: 콘솔 전체가 함께 쓰는 터미널 하나(<kbd>Ctrl</kbd><kbd>`</kbd>).
- **Codex**: 프로젝트 위키. 실험 기능인 Cowork를 켜면 AI가 문서 수정안을 쓰고, 내가 적용하기 전까지는 아무것도 바뀌지 않습니다.
- **스킬**: 스킬을 둘러보고 설치합니다.

공급자 한도는 오른쪽 위 사용량 미터에 늘 보이고, 누르면 자세히 볼 수 있습니다.

대화 옆에는 다음도 열 수 있습니다.

- **플릿 브라우저**(<kbd>Alt</kbd><kbd>B</kbd>, 데스크톱 전용)는 내가 보는 탭을 에이전트가 그대로 조작하는 브라우저이며, 페이지에 주석을 달아 넘길 수 있습니다. 대화와의 경계를 끌어 폭을 바꿉니다.

**Console Use**를 쓰면 에이전트가 콘솔 자체를 다룰 수 있고, **Computer Use**는 그 범위를 Mac 앱까지 넓힙니다. 둘 다 세션마다 따로 허용하며, 요청은 패널 안에서 하나씩 승인합니다.

## 어떤 화면에서든

**데스크톱.** Fleet Console Desktop은 macOS·Windows·Linux용 얇은 네이티브 셸이며 [GitHub Releases](https://github.com/sbluemin/fleet-harness/releases/latest)에서 받을 수 있습니다. 콘솔 런타임을 스스로 관리하고, macOS와 Windows에서는 스스로 업데이트합니다.

**원격 접속.** 원격 접속은 설정의 **원격 접속** 페이지에서 직접 설정하기 전까지 꺼져 있습니다. 켜더라도 콘솔은 페어링한 기기에만 열립니다.

- 접속 링크는 한 번만 쓸 수 있고 15분이 지나면 만료됩니다.
- 모든 링크는 콘솔의 인증서에 고정됩니다.
- 한 번에 한 기기만 조작하고, 나머지는 분명히 표시된 커튼 뒤에서 지켜봅니다.
- 입력 없이 지켜보기만 하는 모니터링 전용 링크도 만들 수 있습니다.
- 공인 인터넷으로 여는 것은 따로 한 번 더 켜야 합니다.

<img src=".github/mobile.webp" alt="폰의 Fleet: 사령관이 맨 위에 있는 대화 목록, 채팅, 달성 기준 승인을 기다리는 목표" width="100%" />

**모바일.** 책상에 두고 온 대화가 폰에도 그대로 있습니다. 홈 화면에는 Theater의 사령관을 맨 위에 두고 대화가 늘어서며, 목표의 보드는 그 대화에서 열립니다. 그래서 폰에서도 기준을 승인하고 결정에 답하고 일을 개시하거나 완료할 수 있습니다. Android와 iOS 앱은 테스터 배포 중이며, 소스는 [`runtime/fleet-mobile`](runtime/fleet-mobile)에 있습니다.

## 기본은 로컬

- 서버는 루프백에만 바인딩됩니다. 원격 접속을 켜기 전에는 다른 기기에서 닿지 않습니다.
- 공급자 자격증명은 콘솔 안에 머뭅니다. 브라우저가 받는 것은 한 번 쓰고 버리는 터미널 티켓뿐입니다.
- 세션과 설정, 기록은 내 머신의 `~/.fleet` 아래에 저장됩니다.

## 내 방식대로

테마는 **다크**와 **라이트** 중에서 고릅니다. 인터페이스와 터미널 글꼴을 내 머신에 설치된 글꼴 중에서 고르고, 움직임을 줄이거나 아바타를 차분하게 두고, 단축키를 모두 다시 지정할 수 있습니다. 콘솔은 한국어와 영어를 지원하며 새로고침 없이 바로 전환됩니다.

## 더 알아보기

- [Fleet Development Reference](docs/fleet-development-reference.md): 호스트 확장, 플러그인 제작, 격리된 개발용 콘솔 실행
- [Console Agent SDK](docs/console-agent-sdk.md): 플러그인이 기대는 계약
- [Admiral Workflow Reference](docs/admiral-workflow-reference.md): 오케스트레이션 아키텍처와 교리
- [Desktop 가이드](runtime/fleet-desktop/README.md): 배포물, 업데이트, 현재 한계
- [변경 이력](CHANGELOG.ko.md): 릴리스 기록

## 라이선스

[MIT](LICENSE)
