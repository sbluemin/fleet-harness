<p align="center">
  <img src=".github/logo.png" width="420" alt="Fleet" />
</p>

<h1 align="center">하나의 콘솔. 모든 프론티어 코딩 에이전트.</h1>

<p align="center">
  <strong>Fleet Console은 Claude Code와 Claude Gateway를 서버가 소유하는 살아 있는 Operation으로 실행합니다.</strong><br/>
  하나의 로컬 워크스페이스에서 배치하고, 관측하고, 위임하며, Session Analyst에서는 Cursor Agent도 사용할 수 있습니다.<br/>
  네이티브 에이전트 런타임. 공식 프로토콜. API 래핑이나 프록시 없음.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dotobokuri/fleet-console"><img src="https://img.shields.io/npm/v/@dotobokuri/fleet-console?color=c9a455" alt="npm"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-4aab8f" alt="License"></a>
  <br/>
  <a href="README.md">English</a> · <a href="README.ko.md">한국어</a>
</p>

## 한 번의 명령으로 시작

Node.js 20.19+ 와 `PATH`에 등록된 인증 완료 에이전트 CLI가 하나 이상 필요합니다.

```bash
npm install -g @dotobokuri/fleet-console

fleet-console          # 로컬 콘솔을 시작하고 브라우저로 엽니다
```

`fleet-console`은 `status`, `restart`, `stop`도 지원합니다. 모든 실행은 내 머신 안에서 이루어집니다. 서버는 루프백에만 바인딩되며, 브라우저에는 MCP·세션 토큰이 전달되지 않습니다.

네이티브 창을 원한다면 [최신 GitHub Release](https://github.com/sbluemin/fleet-harness/releases/latest)에서 플랫폼 빌드를 설치하세요.

## 탭을 닫아도 에이전트는 계속 일합니다

**Operation**은 브라우저가 아니라 로컬 Fleet Console 서버가 소유하는 실제 터미널 세션입니다. 탭을 닫으면 소켓만 분리되고, PTY는 계속 실행되며 출력도 계속 쌓입니다. 콘솔을 다시 열면 세션이 스크롤백을 재생하고 하던 일을 이어갑니다.

유휴 에이전트는 방치되지 않고 회수됩니다. 직접 지정한 임계 시간이 지나면 조용한 세션은 휴면 상태로 내려가고, 클릭 한 번으로 되살아납니다. Operation을 닫거나 Theater를 등록 해제해도 몇 초 동안은 되돌릴 수 있어 오조작에 비용이 들지 않습니다.

**Theater**는 프로젝트 폴더입니다. 작업하는 만큼 등록해 두면 모든 패널과 세션, 도구가 활성 Theater를 따라갑니다.

## 창이 아니라 작업을 배치합니다

Operation은 무한 캔버스 위에 놓입니다. 작업에 맞게 끌어다 두고, Map으로 전체를 조망하고, <kbd>Alt</kbd>+<kbd>F</kbd>로 Formation(그리드·컬럼·로우)에 정렬하세요. <kbd>Alt</kbd>+<kbd>S</kbd>는 사이드바를 상태 보드로 전환해 작업 중·대기·유휴를 한눈에 보여줍니다.

<kbd>⌘</kbd>+<kbd>K</kbd>는 콘솔 전체에 닿습니다. Operation은 물론 저장소 커밋, 파일, Skill까지 검색하고, 재개·닫기·최소화·이름 변경·그룹 변경·액센트 변경·Formation 전환 같은 동작을 곧바로 실행합니다.

## 프로젝트 컨텍스트를 터미널 옆에

<img src=".github/console-repository.png" alt="라이브 에이전트 Operation 옆에 Repository 패널이 열린 Fleet Console" width="100%" />

Activity Rail에는 **Alerts, Codex, Shell, Files, Repository, Skills, Ledger** 7개 패널이 기본 탑재되며, 설치한 플러그인이 자체 패널을 더할 수 있습니다. Repository 패널 하나로 활성 Theater의 히스토리, 작업 변경분, 비교, 워크트리, 브랜치, 태그, 스태시를 감독 중인 Operation을 떠나지 않고 확인할 수 있습니다. 각 패널은 자기 너비를 기억하며, 캔버스를 밀어내는 대신 그 위에 띄울 수도 있습니다.

## 위임한 Carrier의 작업을 실시간으로

<img src=".github/console-carrier-streams.png" alt="Vanguard 정찰 출격이 실시간으로 스트리밍되는 Fleet Console Carrier Streams 컴패니언" width="100%" />

에이전트가 **Carrier**에게 작업을 위임하면 해당 Operation 옆에 Carrier Streams 컴패니언이 열리고, 전달된 출격 명령·되돌아오는 스트리밍 답변·지금 실행 중인 도구를 그대로 보여줍니다. 백그라운드 전문가가 무엇을 하는지 더는 추측하지 않아도 됩니다.

## 세션을 건드리지 않고 세션에 대해 묻기

<img src=".github/console-session-analyst.png" alt="라이브 세션에서 인수인계 브리핑 아티팩트를 생성하는 Fleet Console Session Analyst" width="100%" />

**Session Analyst**는 개별 Operation을 위한 읽기 전용 인텔리전스입니다. 무슨 일이 있었는지 되짚거나, 검토가 필요한 지점을 짚거나, 인수인계 브리핑을 작성하도록 지시하세요. 호스트 에이전트를 건드리지 않고 세션을 읽어 답합니다. 분량이 큰 결과물은 **Artifacts** 컴패니언으로 발행됩니다. 근거가 인용된 문서가 렌더링되어 세션 옆 전용 창에 남습니다. 분석기 자신이 사용할 CLI·모델·추론 강도도 직접 고를 수 있습니다. 감독 중인 모델과 같을 필요는 없습니다.

## 전문 Carrier를 각각 독립적으로 설정

<img src=".github/console-carrier-settings.png" alt="두 개의 CLI 백엔드로 Task Force가 구성된 Nimitz 함장을 보여주는 Fleet Console Carrier 설정" width="100%" />

Fleet에는 네 개의 Carrier가 기본 탑재됩니다. **Nimitz**(전략 판단), **Genesis**(수석 엔지니어), **Sentinel**(QA·보안), **Vanguard**(정찰). Settings → Plugins → Terminal → Carriers에서 각 Carrier의 CLI 백엔드·모델·추론 강도를 개별 지정합니다. 보안을 감사하는 전문가가 기능을 작성하는 모델과 같은 모델 위에서 돌 이유는 없습니다.

Nimitz와 Vanguard는 여기에 더해 **Task Force**를 지원합니다. 둘 중 하나에 CLI 백엔드를 둘 이상 지정하면 한 번의 출격이 그 전부에서 동시에 실행되어, 단일 모델의 첫 답변에 기대는 대신 접근 방식을 비교하고 합의를 확인할 수 있습니다.

## 네이티브 런타임을 대체하지 않고 조율

각 지원 CLI에는 제작사가 다듬은 모델 네이티브 에이전트 루프가 있습니다. Fleet은 선언된 제품 표면에서 실제 CLI 바이너리를 실행하고 지원 프로토콜로 통신하므로, 이미 사용 중인 기능과 인증 모델을 그대로 보존합니다.

| CLI | 제공자 | 프로토콜 | 제품 표면 |
|---|---|---|---|
| **Claude Code** | Anthropic | ACP | 라이브 Agent Operation |
| **Claude (Gateway • Experimental)** | OpenAI, Cursor, Moonshot AI | Claude Code gateway | GPT·Cursor·Kimi K3 모델을 사용하는 라이브 Agent Operation |
| **Cursor Agent** | Cursor | ACP | Session Analyst |

Kimi K3는 AI Gateway의 Claude Code 모델 피커에서 선택합니다. Settings → Plugins → Terminal → Agent CLI에서 API 키를 등록하면 자격 증명은 로컬 게이트웨이에만 남고 Claude Code 프로세스에는 주입되지 않습니다.

Fleet은 이를 명확한 지휘 체계로 표현합니다. 사용자는 **Admiral of the Navy(대원수)**, 워크스페이스 호스트는 **Admiral(제독)**, 각 전문 **Carrier**는 Captain 페르소나가 지휘합니다. 이 메타포는 장식이 아니라 소유권·위임·검증을 명확하게 만드는 운용 언어입니다.

## 내 취향대로

**Instrument**, **Maritime**, **Carbon** 세 가지 테마가 전체 표면을 다시 조율하고, UI 서체와 터미널 서체는 각각 따로 설정합니다. 콘솔 크롬, 설정, 단축키, 기본 플러그인까지 한국어와 영어를 모두 지원하며 새로고침 없이 즉시 전환됩니다.

Fleet Wiki는 아키텍처 결정, 제품 히스토리, 리뷰 큐를 실행 환경과 같은 워크스페이스에 보존해, 변경의 근거가 그것을 만든 트랜스크립트보다 오래 남게 합니다.

## Fleet Console Desktop — 필요할 때 네이티브로

Fleet Console Desktop은 Fleet Console 위의 선택적 얇은 네이티브 셸이며, 두 번째 서버나 분기된 UI가 아닙니다. 표준 Console 서비스를 감독하고 정확한 루프백 원본을 검증한 뒤, 샌드박스 처리된 Node-free 렌더러에서 같은 `/console/` 제품을 로드합니다.

- 네이티브 창, 트레이 라이프사이클, 플랫폼 업데이트 흐름
- 사용자 상태와 독립적으로 교체 가능한 관리형 Node·Console 런타임
- 위에서 본 것과 동일한 Operations, Activity Rail, 컴패니언, 설정
- 브라우저 채널과 안전하게 공존하며 검증되지 않은 Console 프로세스를 종료하지 않음

[최신 GitHub Release](https://github.com/sbluemin/fleet-harness/releases/latest)에서 플랫폼 아티팩트를 설치하세요. 아티팩트, 업데이트 동작, 현재 제한은 [Desktop 가이드](runtime/fleet-desktop/README.md)를 참조하세요.

> Fleet Console은 리서치 프리뷰입니다.

## 더 알아보기

- [Fleet 개발 레퍼런스](docs/fleet-development-reference.md) — 호스트 확장과 SDK
- [제독 워크플로 레퍼런스](docs/admiral-workflow-reference.md) — 오케스트레이션 아키텍처와 원칙
- [변경 이력](CHANGELOG.ko.md) — 릴리스 히스토리

## 라이선스

MIT
