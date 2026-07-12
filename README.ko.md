<p align="center">
  <img src=".github/logo.png" width="420" alt="Fleet" />
</p>

<h1 align="center">하나의 함대. 모든 프론티어 CLI.</h1>

<p align="center">
  <strong>Claude Code, Codex, OpenCode, Cursor Agent를 하나의 로컬 함대에서 지휘하세요.</strong><br/>
  네이티브 에이전트 런타임. 공식 프로토콜. API 래핑이나 프록시 없음.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dotobokuri/fleet-cli"><img src="https://img.shields.io/npm/v/@dotobokuri/fleet-cli?color=c9a455" alt="npm"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-4aab8f" alt="License"></a>
  <br/>
  <a href="README.md">English</a> · <a href="README.ko.md">한국어</a>
</p>

<div align="center">
  <img src=".github/fleet-harness.gif" alt="여러 Carrier를 오케스트레이션하는 Fleet CLI" width="720" />
</div>

## 하나의 지휘 체계, 세 가지 작업 방식

Fleet은 각 CLI의 네이티브 에이전트 루프를 그대로 보존하면서 기획, 디스패치, 관측, 결과 비교를 하나의 지휘 체계로 연결합니다.

| 제품 | 시작 방법 | 가장 적합한 경험 |
|---|---|---|
| **Fleet CLI** | `fleet` | 터미널을 벗어나지 않는 빠른 키보드 중심 지휘 |
| **Fleet Console** | `fleet console` | 공간형 멀티 에이전트 작전, 라이브 터미널, 프로젝트 도구, 시각적 설정 |
| **Fleet Console Desktop** | [최신 GitHub Release](https://github.com/sbluemin/fleet-harness/releases/latest) | 관리형 런타임과 업데이트를 갖춘 선택적 네이티브 Console 창 |

세 제품은 같은 Carrier와 오케스트레이션 엔진을 지휘합니다. Fleet은 로컬에서 실행되고 Console은 루프백 전용이며, 브라우저 표면에는 MCP·세션 토큰이 전달되지 않습니다.

## 함대 시작하기

Node.js 20+와 `PATH`에 등록된 인증 완료 지원 CLI가 하나 이상 필요합니다.

```bash
npm install -g @dotobokuri/fleet-cli

fleet              # 터미널 지휘 센터
fleet console      # 로컬 웹 지휘 센터
```

설치 후 `fleet --help`로 CLI를 검증하고 원하는 인터페이스를 실행하세요.

## Fleet Console — 작전 전체를 한눈에

Fleet Console은 병렬 에이전트 작업을 탐색 가능한 작전 공간으로 바꿉니다. 각 Operation은 로컬 서버가 소유하는 실제 터미널 세션이므로 브라우저 탭을 닫아도 작업은 중단되지 않습니다.

### 라이브 작업을 공간에 배치

<img src=".github/console-operations.png" alt="Claude Operation 2개와 Codex, Shell이 배치된 Fleet Console Formation View" width="100%" />

무한 캔버스에 여러 Operation을 열고 작업에 맞게 배치하세요. Map으로 전체를 조망하거나 Formation으로 Claude, Codex, Shell과 다른 에이전트 런타임을 하나의 집중 작업 세트로 정렬할 수 있습니다. Theater 사이드바에서는 모든 프로젝트와 세션에 즉시 접근합니다.

### 터미널 옆에 프로젝트 컨텍스트 배치

<img src=".github/console-workspace.png" alt="Files Activity Rail이 열린 Fleet Console" width="100%" />

Activity Rail은 Files, Plans, Diff, History, Skills, Alerts, Global Shell을 라이브 Operation 옆에 둡니다. 지원 패널은 서버에 영속된 Theater 경로 컨텍스트를 공유하므로, 원본 파일시스템 경로를 브라우저에 노출하지 않고 탐색 범위를 동기화합니다.

### 트랜스크립트가 아닌 결정을 축적

<img src=".github/console-codex.png" alt="Codex Fleet Wiki 패널이 열린 Fleet Console" width="100%" />

Fleet Wiki는 아키텍처 결정, 제품 히스토리, 가이드, 리뷰 큐를 실행 환경과 같은 워크스페이스에 보존합니다. 작전을 벗어나지 않고 지식을 검색하고 검토할 수 있습니다.

### 모든 전문 Carrier를 독립적으로 설정

<img src=".github/console-carriers.png" alt="Fleet Console Carrier Settings" width="100%" />

각 Carrier의 CLI 백엔드, 모델, 추론 강도, Task Force 구성을 하나의 시각적 로스터에서 선택합니다. 기본 제공되는 8개의 전문 Carrier는 전략, 기획, 구현, 다단 실행, QA, 정찰, 외부 인텔리전스, 문서화를 담당합니다.

> Fleet Console은 리서치 프리뷰입니다.

## Fleet CLI — 키보드에서 지휘

Fleet CLI는 셸을 벗어나지 않고 같은 함대를 기획·디스패치·감시하는 터미널 네이티브 브리지입니다.

<img src=".github/hud.png" alt="Fleet CLI Bridge HUD" width="100%" />

Bridge는 풀 에디터, 실시간 Carrier 상태, 세션 상태, 토큰 사용량, 비용, 스트리밍 결과를 하나의 키보드 중심 화면에 결합합니다.

<img src=".github/carrier_status.png" alt="Fleet CLI Carrier Roster" width="100%" />

Mission Control은 Carrier Roster와 함대 전체 제어를 제공합니다. **Sortie**로 한 전문 Carrier를 출격시키거나, 여러 Carrier를 병렬 배치하거나, 여러 CLI 백엔드에 **Task Force**를 실행해 접근 방식을 비교하고 합의를 확인할 수 있습니다.

## Fleet Console Desktop — 필요할 때 네이티브로

Fleet Console Desktop은 Fleet Console 위의 선택적 얇은 네이티브 셸이며, 두 번째 서버나 분기된 UI가 아닙니다. 표준 Console 서비스를 감독하고 정확한 루프백 원본을 검증한 뒤, 샌드박스 처리된 Node-free 렌더러에서 같은 `/console/` 제품을 로드합니다.

<img src=".github/desktop-console.png" alt="Instrument 테마에서 4개 Operation Formation을 실행하는 Fleet Console Desktop" width="100%" />

- 네이티브 창, 트레이 라이프사이클, 플랫폼 업데이트 흐름
- 사용자 상태와 독립적으로 교체 가능한 관리형 Node·Console 런타임
- 위에서 본 것과 동일한 Operations, Activity Rail, Carrier Settings, Fleet Wiki
- 브라우저·CLI 채널과 안전하게 공존하며 검증되지 않은 Console 프로세스를 종료하지 않음

[최신 GitHub Release](https://github.com/sbluemin/fleet-harness/releases/latest)에서 플랫폼 아티팩트를 설치하세요. 아티팩트, 업데이트 동작, 현재 제한은 [Desktop 가이드](runtime/fleet-desktop/README.md)를 참조하세요.

## 네이티브 런타임을 대체하지 않고 조율

각 지원 CLI에는 제작사가 다듬은 모델 네이티브 에이전트 루프가 있습니다. Fleet은 실제 CLI 바이너리를 실행하고 지원 프로토콜로 통신하므로, 이미 사용 중인 기능과 인증 모델을 그대로 보존합니다.

| CLI | 제공자 | 프로토콜 | 대표 강점 |
|---|---|---|---|
| **Claude Code** | Anthropic | ACP | 심층 추론과 아키텍처 판단 |
| **Codex CLI** | OpenAI | ACP | 빠른 구현과 반복 실행 |
| **OpenCode Go** | OpenCode | ACP | 폭넓은 오픈 모델 접근 |
| **Cursor Agent** | Cursor | ACP | 다중 모델 라우팅 |

Fleet은 이를 명확한 지휘 체계로 표현합니다. 사용자는 **Admiral of the Navy(대원수)**, 워크스페이스 호스트는 **Admiral(제독)**, 각 전문 **Carrier**는 Captain 페르소나가 지휘합니다. 이 메타포는 장식이 아니라 소유권, 위임, 검증을 명확하게 만드는 운용 언어입니다.

## 더 알아보기

- [Fleet 개발 레퍼런스](docs/fleet-development-reference.md) — 호스트 확장과 SDK
- [제독 워크플로 레퍼런스](docs/admiral-workflow-reference.md) — 오케스트레이션 아키텍처와 원칙
- [변경 이력](CHANGELOG.ko.md) — 릴리스 히스토리

## 라이선스

MIT
