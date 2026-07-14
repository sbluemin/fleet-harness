# Changelog

All notable changes to this project will be documented in this file.
This format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.26.1] - 2026-07-14

### fleet-desktop

#### Fixed
- [fleet-console] 터미널의 HTTP 및 HTTPS 링크를 외부 브라우저에서 열고 웹이 아닌 스킴은 차단합니다.

### fleet-plugin

#### Changed
- [fleet-console] Console 터미널 렌더링을 xterm 6으로 업그레이드하면서 수동 스크롤백과 테마 기반 viewport 채움을 유지합니다.

#### Fixed
- [fleet-console] 탐색 경고를 유지하면서 검증된 OSC 8 목적지를 최초 브라우저 요청에 전달합니다.
- [fleet-console] 마우스 드래그 후 로컬 터미널 선택 내용을 클립보드에 복사합니다.
- [fleet-console] Windows에서 선택한 터미널 텍스트를 브라우저 DevTools 실행이나 활성 CLI 중단 없이 Ctrl+Shift+C로 복사합니다.

### fleet-core

#### Fixed
- [fleet-admiral] Windows의 Codex 세션에서 여러 줄 입력을 다시 사용할 수 있습니다.

## [1.26.0] - 2026-07-13

### fleet-cli

#### Fixed
- [fleet-cli] Windows에서 carrier-result 리마인더가 프롬프트에 남지 않고 Codex TUI에 제출됩니다.

### fleet-console

#### Added
- [fleet-console] 별도 Console 기능 모드 없이 선택적 Desktop 감독을 위한 안정적인 루프백 페어링 식별자를 제공합니다.
- [fleet-console] Formation view에 Grid / Columns / Rows 레이아웃 선택기를 추가합니다. Columns는 울트라와이드 모니터용으로 패널을 풀하이트 세로 컬럼으로 나누며, 선택은 기기별로 기억됩니다.

#### Changed
- [fleet-console] 미니맵 접기 컨트롤을 복원하고 Formation 및 패널 최대화 중에는 Map 화면과 단축 아이콘을 숨깁니다.
- [fleet-console] 사이드바 액션 컨트롤을 hover 또는 키보드 포커스에서만 표시해 Operation 이름 공간을 넓힙니다.
- [fleet-console] 캐리어 스트림 도크를 오버레이로 띄워, 펼쳐도 터미널 크기가 바뀌지 않습니다.
- [fleet-console] 레이아웃 버튼으로 Formation view에 진입하도록 바꾸고, Reset view를 사이드바 인라인 버튼으로 옮기며, 캔버스 우클릭 메뉴를 사이드바 메뉴와 동일한 Launch 목록으로 통일합니다.

#### Fixed
- [fleet-console] 우측 레일의 긴 Codex Wiki 엔트리 목록에서 마우스 휠 스크롤을 복원합니다.
- [fleet-console] Console과 좌우 사이드 크롬의 크기를 조절할 때 Command Band 컨텍스트가 점진적으로 중앙 정렬되도록 유지합니다.

#### Removed
- [fleet-console] 최소화된 패널을 포함해 Formation view를 여는 Alt+Shift+F 단축키를 제거합니다.
- [fleet-console] 대화형 Operation 실행 컨트롤과 Console 세션 캡처에서 Cursor를 제거합니다.

### fleet-desktop

#### Added
- [fleet-console] Desktop이 정상 Console 시작을 완료한 뒤 Desktop 소유의 샌드박스 입력창을 사용해 macOS 앱 메뉴 또는 Windows와 Linux 트레이에서 실행 중인 로컬 Fleet Console에 연결합니다.

### fleet-plugin

#### Changed
- [fleet-console] 제한된 디렉터리 범위를 미리 가져와 대규모 디렉터리 목록을 표시할 때 File Explorer의 응답성을 개선합니다.

#### Fixed
- [fleet-console] node-pty helper가 실행 권한 없이 설치된 경우에도 macOS Terminal PTY 시작을 복구합니다.
- [fleet-console] Windows ConPTY에서 터미널 carrier-result 리마인더가 Codex에 안정적으로 제출됩니다.

### fleet-core

#### Removed
- [fleet-admiral] Carrier용 Cursor 백엔드는 유지하면서 Fleet Admiral의 Cursor 실행 주입과 플러그인 렌더링을 제거합니다.

## [1.25.0] - 2026-07-12

### fleet-console

#### Added
- [fleet-console] `Mod+B`와 `Mod+Alt+B` 단축키로 좌측 사이드바와 우측 Activity Rail을 토글합니다.
- [fleet-console] 좌측 사이드바 operation 칩에 최소화 버튼을 추가하여 사이드바에서 바로 패널을 최소화할 수 있게 합니다. 버튼은 hover 시 close 버튼 왼쪽에 나타나며, 이미 최소화된 칩과 비활성 Theater의 preview 칩에는 표시하지 않습니다.
- [fleet-console] 비활성 Operation 이름을 패널 상태 비콘 옆에 표시하고 인라인 이름 변경 기능을 제공합니다.

#### Changed
- [fleet-console] 사이드바 Formation view 토글을 2분할 세그먼트 컨트롤로 나눠, 열린 패널만과 최소화 패널 포함 Formation을 각각의 버튼으로 제공합니다.
- [fleet-console] What's New를 Overview 및 제품 탭으로 구성하면서 레거시 및 혼합 릴리스 업데이트를 보존합니다.
- [fleet-console] Formation view의 열린 패널만 세그먼트는 이제 최소화·최대화로 도크에 내려간 패널을 그대로 두고 현재 열린 패널만 정렬하며, 최소화 패널 포함 세그먼트는 여전히 모든 패널을 먼저 복원합니다.
- [fleet-console] 세션 중 각 Theater를 처음 열 때 기존 Operation 패널을 최소화된 상태로 시작하고, 선택한 패널만 단독으로 나타냅니다.
- [fleet-console] 기본 캔버스 화면에서 미니맵을 항상 표시하고 Map 접기 버튼을 제거합니다.

#### Fixed
- [fleet-console] 릴리스 노트가 모달 본문을 넘쳐도 What's New 제어 버튼이 계속 보이도록 합니다.

### fleet-desktop

#### Added
- [fleet-console] 저장된 Fleet Console 테마와 실시간 테마 변경에 맞춰 Fleet Desktop Windows 제목 표시줄 오버레이를 동기화합니다.
- [fleet-console] 영속 줌 수준을 사용하는 네이티브 Console 확대와 새로 고침 제어를 추가합니다.

#### Fixed
- [fleet-console] macOS 로그인 셸 PATH에서 Agent CLI 검색을 복원합니다.
- [fleet-console] Console 전환 후 뒤로가기로 부트스트랩 페이지가 다시 열리지 않도록 수정했습니다.

### fleet-plugin

#### Changed
- [fleet-console] Diff History 커밋 뷰를 Segmented Commit Inspector로 개편합니다. Details 탭은 작성자, 상대·절대 시각, 복사 가능한 전체 SHA, 클릭 가능한 부모, ref 칩, 메시지 본문을 보여주고 Changes 탭은 파일 단위 탐색, 변경 파일의 목록·트리 뷰, 구문 강조 diff를 제공합니다.
- [fleet-console] 기본 History rail 폭에서도 커밋 제목이 잘리지 않게 하고 브랜치 그래프를 좌측 마스터로 유지하며 그래프, 인스펙터, 파일 창 사이에 크기 조절 구분자를 추가합니다.
- [fleet-console] 새 Codex Agent CLI 설정의 기본값을 App Server로 지정하며 명시적인 ACP 선택은 유지합니다.

#### Fixed
- [fleet-console] Diff History 커밋 그래프 노드를 해당 커밋 행에 정렬해 각 그래프 마커가 더 이상 커밋보다 반 행 아래로 어긋나지 않게 합니다.
- [fleet-console] 스트리밍 상태 패널이나 다른 레이아웃 변경으로 터미널 크기가 바뀌어도 사용자의 스크롤 위치를 보존합니다.

### fleet-core

#### Changed
- [fleet-carriers] 완료된 캐리어 작업 정보를 6시간 동안 보존합니다.
- [core-unified-agent] 시작 모드 재정의가 없으면 Codex 연결에 App Server를 사용합니다.
- [core-unified-agent] Claude와 Codex의 Carrier 지침을 제출 프롬프트에 함께 전달하고 Kirov 디스패치가 플랜 파일을 지정하고 생성하도록 요구합니다.
- [fleet-carriers] 각 Carrier 디스패치를 새로운 CLI 프로세스에서 실행하고 `context_id`를 반환하며, 호출자가 이를 `resume_context_id`로 전달하면 실제 프로바이더 세션을 재개합니다.

## [1.24.0] - 2026-07-11

### fleet-cli

#### Added
- [fleet-cli] 새 캐리어 세션을 열 때 저장된 Codex 시작 선택을 적용합니다.

#### Removed
- [fleet-cli] 더 이상 지원하지 않는 `--native` 터미널 전용 시작 모드를 제거하여 Fleet CLI가 항상 임베디드 2개 패널 앱을 엽니다.

### fleet-console

#### Added
- [fleet-console] 원자적 UI 글꼴 및 크기 환경설정을 갖춘 Typography Font Browser를 추가합니다.
- [fleet-console] 엄선된 Manrope, JetBrains Mono, Source Code Pro 선택지를 제공하는 서버 저장 전역 UI 글꼴 환경설정을 추가합니다.
- [fleet-console] 활성 Theater의 실행 계획을 웨이브/작업 진행률과 병렬 레인 디스패치 준비 상태로 보여 주고, 강화된 인패널 마크다운 리더에서 열 수 있는 Plans 활동 레일 패널을 추가합니다.
- [fleet-console] 표시되는 Operations를 감독할 수 있는 임시 Formation 보기를 추가했습니다.
- [fleet-console] Theater 루트, 워크트리 또는 디렉토리를 선택하는 공유 Activity Rail 경로 컨텍스트를 추가합니다.
- [fleet-console] 창 크롬을 44px Command Band로 통합합니다: 사이드바·Activity Rail 토글, Operation 검색, Formation view 토글이 패널을 접어도 움직이지 않는 고정 위치에 상주합니다.
- [fleet-console] 사이드바와 Activity Rail의 접힘/펼침에 200ms 폭 전환 애니메이션을 추가하며, prefers-reduced-motion 환경에서는 완전히 비활성화됩니다.
- [fleet-console] 플로팅 에지 펼침 탭과 사이드바 헤더 버튼 행을 퇴역시키고, Add Theater는 사이드바 최상단 전폭 행으로 이동합니다.
- [fleet-console] Fleet 브랜드 마크를 Command Band로 옮겨 Operations 홈 버튼으로 삼고, macOS 신호등 인셋을 넓힙니다.
- [fleet-console] 밴드 중앙을 활성 Theater, 더블클릭 이름 변경이 가능한 활성 패널 이름, 아이콘과 텍스트 태그로 표시되는 패널 CLI의 브레드크럼으로 재해석합니다.
- [fleet-console] 패널 hover 컨트롤을 상태 dot과 최소화·최대화·닫기만으로 축소하고, dot는 평상시 닫기 슬롯에 머물다 hover 시 왼쪽으로 슬라이드합니다.
- [fleet-console] Activity Rail의 경로 컨텍스트 칩을 Command Band에도 노출해 동기화된 두 번째 표면으로 제공합니다.
- [fleet-console] 사이드바 브랜드 푸터를 System Menu와 Help 드롭업으로 재편하고, Keyboard Shortcuts를 Help 모달로 옮기며 캔버스 컨텍스트 메뉴에서는 제거합니다.
- [fleet-console] Settings와 Carriers 화면에도 브랜드와 검색만 활성화된 Command Band를 유지하고 Operations로 돌아가기 링크를 퇴역시킵니다.
- [fleet-console] 서버에 영속되는 언어 환경설정과 함께 영어 및 한국어 What's New 릴리스 노트를 추가합니다.

#### Changed
- [fleet-console] Instrument 시각 체계와 전고형 점진 내비게이션으로 Fleet Console을 전면 개편했습니다.
- [fleet-console] 열려 있는 패널용 Formation 단축키와 최소화 패널을 복원하는 단축키를 분리합니다.
- [fleet-console] Operation 패널이 별도의 상단 바를 없애고 일체형 단일 면으로 바뀌며, 평상시에는 상태 dot만 보이다가 마우스를 올리면 이름·CLI 배지·창 조작 버튼이 담긴 우측 상단 클러스터가 나타나고 이 클러스터가 이동 핸들도 겸합니다.
- [fleet-console] 사이드바의 Canvas controls 버튼을 Formation view 토글로 교체하고 검색과 접기 버튼의 위치를 서로 바꿉니다.

#### Fixed
- [fleet-console] General 설정에 테마 섹션을 복원하고 Instrument 기본값과 Maritime, Carbon 테마 선택을 지원합니다.
- [fleet-console] Command Band 배경이 테마별 크롬 팔레트를 따르도록 바로잡아 Maritime·Carbon 테마에서 중앙·우측 구간이 지나치게 어둡던 문제를 해결했습니다.
- [fleet-console] Map Operation 패널의 사용자 선택 색상 외곽선과 Operations SideBar 칩의 사이드 틱을 복원합니다.
- [fleet-console] Activity Rail 리사이즈 드래그가 커서를 지연 추적하다 멈춰야 따라잡던 문제를 고쳐 1:1로 즉시 따라오도록 수정.
- [fleet-console] Map 세션 패널을 닫기 전에 확인을 요구합니다.
- [fleet-console] 활성 Fleet Console 프로세스를 방해하지 않으면서 시작 시 오래된 플러그인 번들을, 종료 시 현재 실행의 번들을 정리합니다.

#### Removed
- [fleet-console] 현지화된 What's New 릴리스 노트에서 English fallback 배지를 제거합니다.

### fleet-desktop

#### Added
- [fleet-console] 완전한 Fleet Console 경험을 네이티브 환경에서 제공하는 선택형 Fleet Console Desktop 0.1.0을 선보입니다.
- [fleet-console] 최초 실행 설치, 시작 시 업데이트, 오프라인 폴백, 중단된 설치의 안전한 복구를 포함해 관리형 Console 런타임을 자동으로 준비하고 유지합니다.
- [fleet-console] 단일 인스턴스 창 복원, 플랫폼 타이틀바 통합, 트레이·메뉴 액션, 업데이트 안내, 명확한 시작 충돌 가이드를 포함한 네이티브 데스크톱 수명주기 컨트롤을 제공합니다.
- [fleet-console] 필요할 때만 Console 코드를 내려받고 Fleet Console 데이터는 제거 가능한 관리형 런타임과 분리해 보존하여 데스크톱 셸을 가볍게 유지합니다.

### fleet-plugin

#### Added
- [fleet-console] 새 Codex 캐리어 세션에 ACP 또는 App Server를 선택하는 Agent CLI 설정을 추가하며, 기본값은 ACP입니다.
- [fleet-console] 기본 제공 및 설치된 고정폭 글꼴 선택, 미리보기, 영속 서버 설정을 갖춘 Terminal Font Browser를 추가합니다.
- [fleet-console] Diff 레일에서 변경 파일과 이력 커밋을 바로 필터링할 수 있습니다.
- [fleet-console] 지원되는 Activity Rail 패널이 선택된 Theater 루트, 워크트리 또는 디렉토리 컨텍스트를 따르도록 합니다.

#### Changed
- [fleet-console] 모든 브랜치와 연결된 워크트리에 걸친 저장소 이력을 전용 오른쪽 레일 패널에서 볼 수 있습니다.

#### Fixed
- [fleet-console] Operation 터미널이 선택한 테마를 따르도록 테마별 터미널 색상 팔레트를 복원합니다.
- [fleet-console] Diff 파일 선택, Non-Git Theater 및 좁은 History 레이아웃 문제를 수정합니다.
- [fleet-console] 열지 않은 File Explorer 폴더를 재귀적으로 검색하고 드래그로 History 상세 패널 크기를 조절합니다.
- [fleet-console] 이제 Hook이 제공하는 패널 이름은 실행 중인 패널마다 한 번만 적용되며 사용자가 변경한 이름은 그대로 유지됩니다.

### fleet-core

#### Added
- [core-infra] [core-unified-agent] [fleet-admiral] Codex ACP 또는 App Server 시작 선택을 영속하고 그에 따라 캐리어 세션을 연결하며, 기본값은 ACP입니다.
- [fleet-carriers] 실행 진행 상황이 계획 파일과 Console Plans 화면에 표시되도록, 계획 작성과 웨이브 완료 진행 상태 기록에 기계 판독 가능한 체크박스 작업 계약을 추가합니다.

#### Changed
- [fleet-carriers] [fleet-admiral] 하나의 Kirov 계획에서 안전한 병렬 Ohio 레인을 선언할 수 있으며, Ohio는 Parallel 계획의 Dispatch Manifest 레인 하나를 실행하는 execution_scope를 받고 레거시 또는 Sequential 계획의 전체 순차 실행은 유지합니다.

#### Fixed
- [fleet-admiral] [fleet-carriers] 기본 프롬프트와 캐리어 메타데이터는 중립적으로 유지하면서 해군 역할극이 비유 옵션을 따르도록 수정합니다.

## [1.23.0] - 2026-07-10

### Changed
- [fleet-console] Carrier Stream은 추론 내용을 dock에서 제외하되 접을 수 있는 Details에는 보존하고, 생각 중 상태를 표시합니다.
- [fleet-console] Carrier Stream Details는 Follow 컨트롤로 최신 출력에 고정된 상태를 유지할 수 있습니다.
- [fleet-console] Carrier Stream은 완료된 작업을 Details와 잠시 동안 dock에 계속 표시합니다.
- [fleet-console] Carrier Stream은 오류 트랙을 coral로 표시하고 연결 중인 트랙을 live로 처리합니다.
- [fleet-admiral] Cursor Agent 세션은 항상 적용되는 alwaysApply rules 파일 대신 sessionStart hook의 additional_context 주입을 통해 Fleet doctrine을 받습니다.

### Fixed
- [core-unified-agent] Codex 시스템 프롬프트와 config 재정의가 이제 모든 플랫폼에서 새 ACP 세션에 안정적으로 적용됩니다. 이전에는 조용히 누락되었습니다.
- [fleet-console] 새 console 릴리스가 감지되면 이제 페이지 새로고침 없이 열려 있는 탭에 Update Available 배지가 표시됩니다.

## [1.22.1] - 2026-07-10

### Added
- [core-unified-agent] Codex ACP를 공식 bridge로 전환하고, 업데이트된 reasoning effort 수준과 함께 GPT-5.6 Codex 모델 지원을 추가하며, 마이그레이션 호환성을 위해 폐기된 ACP 모델 유형 별칭을 보존합니다.

## [1.22.0] - 2026-07-08

### Changed
- [fleet-console] 이제 Codex wiki 문서는 읽기 화면에서 평면적으로 렌더링됩니다. 문서 본문을 감싸던 둥근 glass 카드가 제거되고 문서 헤더(breadcrumb, title, tag chips, updated chip)는 유지됩니다.
- [fleet-console] console의 기본 탐색을 하단 command status bar, Theater 트리, 오른쪽 레일 route 컨트롤로 교체했습니다.

### Removed
- [fleet-console] Codex wiki 항목 하단의 copy-context 작업 버튼(Compact context, Provenance, Context pack, Why this matched)을 제거했습니다.

## [1.21.0] - 2026-07-06

### Changed
- [fleet-admiral] [fleet-carriers] 항상 주입되던 Admiral 시스템 프롬프트를 약 19% 줄였습니다. 이제 캐리어 roster에는 선택 및 라우팅 메타데이터만 담기며, 캐리어별 request-block 계약은 세션의 첫 dispatch 전에 로드되는 새로운 온디맨드 carrier-contracts skill로 옮겨졌습니다.
- [fleet-admiral] 중복된 Downward Guard 트리거 목록을 단일 소스로서 Protocol Gate에 통합하고, 규칙을 변경하지 않은 채 Context Confidence 및 Result Integrity Standing Orders를 압축했으며, 캐리어 간 피드백 패턴 표를 frontline protocol skill로 옮겼습니다.
- [fleet-admiral] 이제 Protocol Gate는 세션별 skill 로딩이 멱등적임을 선언하므로 이미 로드된 skill 콘텐츠는 다시 로드하지 않고 적용됩니다.
- [fleet-carriers] 필수 request block 누락으로 거부된 dispatch 요청은 이제 오류에 대상 캐리어의 전체 request-block 계약을 되돌려 주므로 사전 계약 조회 없이 재구성할 수 있습니다.

## [1.20.0] - 2026-07-06

### Added
- [fleet-admiral] Command Integrity Standing Order를 추가했습니다. 이제 Admiral은 기술적으로 결함 있는 지시에 근거를 갖춘 이의를 제기하고, 작업을 시작하기 전에 결정 형태의 요구 사항 모호성을 명확히 하며, 명시적으로 부여된 범위를 넘어서는 권한을 가정하지 않고, 안전성, 정확성, 명확성, 효율성 순으로 충돌하는 지시를 조정합니다.
- [fleet-admiral] 이제 Admiral 시스템 프롬프트는 모든 protocol 모드에서 접촉한 모든 디렉터리에 대해 재귀적으로 AGENTS.md doctrine을 로드하도록 지시하며, 가장 깊게 적용되는 파일이 우선합니다.
- [fleet-console] Operations 사이드바에서 그룹 헤더를 드래그하여 Operation 그룹의 순서를 변경할 수 있도록 추가했습니다.

## [1.19.0] - 2026-07-05

### Added
- [fleet-admiral][fleet-cli][fleet-console] 이제 Cursor Agent를 rules로 전달되는 Fleet doctrine, MCP 및 세션 캡처를 지원하는 일급 Agent CLI 런타임으로 실행할 수 있습니다.
- [fleet-console] 이제 Diff 패널은 Changes 아래에 접을 수 있는 "History" 섹션을 표시하며, 단일 레인 그래프 여백(Flat/Graph 토글)과 함께 최근 커밋을 나열합니다. 커밋을 선택하면 확장된 diff 패널에 전체 다중 파일 패치가 렌더링됩니다. 다중 레인 토폴로지(활성 레인 최대 세 개, 초과분은 접힘)는 HEAD에서 도달 가능한 히스토리 안의 병합과 브랜치를 시각화합니다.
- [fleet-console] terminal glyph 렌더링을 위한 번들 Nerd Font 심볼 폴백 지원을 추가했습니다.
- [fleet-console] 오른쪽 레일에 Theater와 독립적인 Global Shell 패널을 추가했습니다.

### Changed
- [core-process][core-agent][core-unified-agent] 이제 Windows 실행 파일 경로 확인과 자식 프로세스 console 창 억제는 공유 내부 core-process 패키지에서 제공되며, 이전에 agent CLI 및 console 런타임에 중복되어 있던 로직을 대체합니다.
- [core-unified-agent] Claude와 Codex provider 표시 이름을 "Claude Code" 및 "Codex"로 변경했습니다.
- [core-infra] Fleet infrastructure 패키지를 도메인 비종속적 역할에 맞게 이름을 변경했습니다. 모든 소비자는 동작 변경 없이 투명하게 업데이트됩니다.
- [fleet-admiral] [fleet-carriers] 이제 data directory 확인은 자체 완결적이므로, 어떤 host가 실행하든 캐리어 저장소와 marketplace 자산은 항상 단일 Fleet home directory로 확인됩니다.
- [fleet-console] [fleet-cli] host 측 data directory 주입을 제거하여, 이전에 console에서 변경할 때 지속되지 않던 중복 marketplace 렌더링과 캐리어 설정 문제를 수정했습니다.
- [fleet-console] 플러그인이 더 이상 raw data directory 경로를 받지 않도록 plugin host 계약에서 이를 제거했습니다.
- [fleet-console] 이제 Terminal 실행 메뉴와 SideBar chips는 하나의 공유 glyph 대신 Claude 및 Codex agent 세션에 대해 서로 다른 공식 스타일 브랜드 아이콘을 표시합니다.
- [fleet-console] 이제 Terminal 실행 메뉴와 SideBar chips는 중립 폴백 glyph 대신 Cursor agent 세션에 공식 스타일 Cursor 브랜드 아이콘을 표시합니다.

### Fixed
- [fleet-console] File Explorer markdown 미리보기에서 README 이미지와 파일 링크를 복원했습니다.
- [fleet-console] 이제 Terminal Shell 세션은 raw TUI 커서 이동을 보존하므로 nvim 스타일 전체 화면 앱이 안정적으로 다시 그려집니다.
- [fleet-console] 이제 Diff 및 File Explorer 레일 패널은 파일이나 diff를 열 때 오른쪽 목록 또는 트리 열을 고정 너비로 유지하고, 추가 패널 너비 전체를 왼쪽 문서 또는 viewer 패널에 할당합니다.
- [fleet-console] 좁거나 과도하게 크기가 조정된 레일 패널은 콘텐츠를 잘라내는 대신 보조 레이블과 배지를 점진적으로 숨기므로, 극단적인 드래그와 촘촘한 패널 너비에서도 레이아웃이 더 이상 무너지지 않습니다.
- [fleet-console] File Explorer는 파일 미리보기가 열려 있는 동안에만 레일 패널을 확장하고, viewer가 닫히면 단일 열 트리로 돌아갑니다.

### Removed
- [fleet-cli][fleet-console] System Prompt Injection 옵션(Console Terminal 설정의 Append/Replace 토글과 CLI Mission Control의 "System prompt" 행, 그리고 `FLEET_REPLACE_SYSTEM_PROMPT` 환경 재정의)을 제거했습니다. 이제 Fleet doctrine은 항상 Claude Code의 기본 시스템 프롬프트 위에 계층화되어(Append) 적용되며, Codex에는 항상 해당 profile의 developer instructions를 통해 전달됩니다.

## [1.18.0] - 2026-07-04

### Added
- [core-unified-agent] 이제 OpenCode Go 모델 선택에 GLM-5.2 및 Kimi K2.7 Code가 포함됩니다.

### Changed
- [fleet-carriers] 이제 캐리어는 최종 출력을 `<report>` 블록으로 감쌉니다. `carrier_jobs(format:"full")`은 해당 블록만 추출하여 반환하고, 블록이 없으면 전체 archive로 폴백하며, 새로운 `format:"raw"` 옵션은 디버깅을 위해 처리되지 않은 archive를 반환합니다.
- [fleet-carriers] 응답 페이로드 크기를 줄이기 위해 `carrier_jobs` 응답에서 중복 echo 필드(`action`, `format`, `summary_available`)를 제거하고, workspace-changes DTO에서 파생 필드(`attribution`, `available`, `statLine`)를 제거했습니다.
- [fleet-console] 이제 Agent 패널의 캐리어 스트리밍은 패널 하단에 고정된 상주형 접이식 stream dock입니다. 클릭하지 않아도 라이브 출력, 경과 시간 및 토큰 추정치가 항상 표시됩니다. dock은 한 줄 tail로 접히고 상태는 브라우저별로 지속됩니다. dock 헤더에서 "Details"를 클릭하면 전체 트랙 히스토리를 위해 기존 full-stream overlay가 열립니다. 단일 캐리어 작업의 경우 dock 테두리와 배경은 CLI 시그니처 색상(claude, codex, opencode-go, cursor 또는 taskforce)으로 색조 처리되고, 캐리어 이름은 captain token 색상으로 표시되며, dispatch 요청 레이블은 dock 헤더 아래에 표시됩니다.
- [fleet-admiral][fleet-cli] 이제 Codex 실행은 세션 범위 profile 또는 hook trust 우회 대신 hooks가 활성화된 고정 Fleet 관리 profile을 사용합니다.
- [core-unified-agent] 이제 Cursor Agent 모델 선택에는 Kimi K2.7 Code 및 GLM 5.2가 포함되고, 이전 Sonnet 및 Opus 4.7 옵션은 제거됩니다.
- [fleet-console] 이제 Diff 패널에서 파일을 선택하면 draggable split divider를 대체하는 inline diff document 보기와 함께 패널이 two-pane bridge로 확장됩니다.
- [fleet-console] 이제 Diff 패널 파일 행은 파일 이름을 맨 앞에 표시하고, repository picker는 inline 워크트리 행이 포함된 불투명한 in-panel deck으로 열립니다.
- [fleet-console] 이제 Diff 패널 repository dropdown은 연결된 워크트리를 독립 항목으로 나열하는 대신 접을 수 있는 disclosure 아래 parent repository별로 그룹화합니다.
- [fleet-admiral] 이제 Artifact Inspection Gate는 Admiral이 carrier-diff 이탈을 무해하다고 분류하기 전에 증거를 요구합니다. 이탈은 관찰 가능한 동작, 계약 또는 출력을 전혀 변경하지 않고 실제 실행 경로로 도달할 수 없다고 확인되지 않는 한 결함으로 처리됩니다.
- [fleet-console] 동일한 Operation 패널의 반복 alert는 이제 횟수를 누적하는 대신 이전 alert를 대체합니다. ALERTS 배지와 Theater 그룹 집계는 활성 alert가 있는 패널 수를 표시하고, 행별 반복 횟수 배지는 제거됩니다.
- [fleet-console] Skills 패널은 패널 하단에 도킹된 접이식 status dock에 업데이트 및 설치 진행 상태를 표시하여 skill 목록을 가리지 않습니다. dock은 성공 시 자동으로 사라지고 실패 시 Retry 작업을 유지합니다.
- [fleet-console] Agent 패널 캐리어 stream dock을 단일 행 signal strip(라이브 pulse, 캐리어 이름, 최신 출력 줄, 경과 시간 및 토큰 추정치를 한 줄에 표시)으로 압축했으며, 이는 트랙별 하나의 compact 행으로 확장됩니다. 중복된 캐리어 이름, 불필요한 라이브 배지 및 stream 아래의 큰 고정 빈 공간은 제거되고, 이제 다중 캐리어 트랙은 captain 색상의 이름을 표시합니다.

### Fixed
- [fleet-admiral][fleet-cli] 이제 Fleet Codex profile 재작성은 변경되지 않은 hooks의 저장된 hook trust 상태를 보존합니다.
- [fleet-console] Diff 패널에서 diff document 패널과 변경 파일 목록 사이의 drag-to-resize divider를 복원했습니다.
- [fleet-console] 세션 이름 변경 패널 이름이 이제 유지됩니다. 사용자가 설정한 이름은 auto-name으로 절대 덮어쓰이지 않고, auto-name은 첫 번째뿐 아니라 이후 모든 prompt에서 실행되며, 페이지 새로고침 없이 새 SSE channel을 통해 이름 변경이 브라우저에 실시간으로 반영됩니다.

### Removed
- [core-unified-agent][fleet-infra][fleet-admiral][fleet-cli][fleet-console] OpenCode Go 지원은 보존하면서 활성 catalog, 실행 profile, authentication flow, Console model sign-in 및 문서에서 Claude Kimi, Claude GLM 및 Claude ZAI 별칭 provider를 제거했습니다.
- [fleet-carriers] [fleet-admiral] [fleet-cli] [fleet-console] Native Subagent 모드를 제거했습니다. 이제 캐리어는 항상 CLI dispatch 모드로 실행되며 carrier_dispatch와 Task Force는 변경되지 않습니다.

## [1.17.1] - 2026-07-03

### Fixed
- [fleet-console] Operations canvas의 terminal 텍스트는 이제 패닝 또는 확대/축소 후에도 흐릿하게 렌더링되지 않습니다. 패널은 정수 픽셀에 맞춰지고, 패널을 최대화하면 현재 map zoom과 관계없이 terminal이 선명하게 유지되도록 기본 zoom으로 렌더링됩니다.

## [1.17.0] - 2026-07-02

### Added
- [fleet-console] 이제 Console 플러그인은 console server에 자체 설정을 저장할 수 있으며, 설정은 플러그인별로 저장되어 브라우저 변경과 console 재시작 후에도 유지됩니다.
- [fleet-console] 이제 Terminal 글꼴 이름과 크기는 브라우저와 console 재시작 간에 유지됩니다. 기존 브라우저별 글꼴 환경설정은 최초 로드 시 자동으로 마이그레이션됩니다.
- [fleet-console] 이제 File Explorer는 toolbar에 수동 새로고침 버튼을 제공하고, 디렉터리를 확장할 때마다 폴더 내용을 다시 읽으며, 디스크에서 파일이 변경되면 파일 트리를 실시간으로 업데이트합니다.
- [fleet-console] skills.sh registry 검색, inline 진행 스트리밍을 통한 skill 설치, 업데이트, 제거 및 overlay에서 SKILL.md 읽기를 위한 기본 제공 Skills 플러그인을 Activity Rail에 추가했습니다.

### Changed
- [fleet-console] 이제 Diff 패널은 Theater 루트만이 아니라 현재 Theater 아래에 중첩된 모든 Git repository를 대상으로 할 수 있습니다. toolbar에서 하나를 선택하면 현재 branch와 선택 가능한 scan depth가 표시됩니다.
- [fleet-console] 이제 Diff 패널은 분리된 Staged 및 Changes 섹션 대신 단일 통합 Changes 목록(staged와 unstaged를 함께)을 표시합니다.

### Fixed
- [fleet-console] Diff 패널 repository picker dropdown이 패널 밖에 배치되어 잘리는 바람에 클릭해도 나타나지 않던 문제를 수정했습니다.
- [fleet-console] Theater 루트가 Git repository가 아닐 때 Diff 패널은 더 이상 중첩 repository를 자동 선택하지 않습니다. 대신 toolbar picker에서 하나를 명시적으로 선택합니다.
- [core-unified-agent] [fleet-carriers] 성공 결과에 stderr를 추가하지 않으면서 실패한 캐리어 작업에 redacted Codex ACP stderr diagnostics를 포함합니다.
- [fleet-console] Operation Controls에서 지원되지 않는 Claude Kimi 및 Claude GLM 실행 별칭을 숨겼습니다.
- [fleet-console] 이제 Markdown 문서 상단의 YAML frontmatter(예: SKILL.md 미리보기)는 하나의 과도하게 큰 heading으로 합쳐지는 대신 레이블이 있는 metadata card로 렌더링됩니다.
- [fleet-console] 몇 줄 높이로만 접히던 Skills SKILL.md 읽기 overlay 문제를 수정했습니다. 이제 스크롤 가능한 본문과 함께 안정적인 읽기 높이로 열립니다.

## [1.16.1] - 2026-07-02

### Fixed
- [fleet-console] Codex Drydock patch 검토 흐름을 복원했습니다. 이제 보류 중인 patch는 작고 클릭 가능한 목록으로 렌더링되고, 각각은 Codex 읽기 보기에서 제안된 wiki 문서를 열며, 레일 또는 확장된 읽기 overlay에서 이유와 함께 승인하거나 거부할 수 있습니다.
- [fleet-console] Operation Controls에서 지원되지 않는 Claude Kimi 및 Claude GLM 실행 옵션을 비활성화했습니다.
- [fleet-console] 이제 Korean IME 입력은 terminal 패널에서 Shift+Enter로 새 줄을 삽입할 때 조합 중인 텍스트를 함께 유지합니다.

## [1.16.0] - 2026-06-30

### Added
- [fleet-console] Operations 지도 옆에 워크스페이스 도구를 아이콘 탭으로 도킹하는 접기·크기 조절이 가능한 오른쪽 Activity Rail을 추가합니다. 도구를 선택하면 해당 패널이 슬라이드되어 열리고 지도가 재배치되며, 활성 아이콘을 클릭하면 접히고, rail은 새로고침 후에도 활성 도구·너비·열림 상태를 기억합니다.
- [fleet-console] 활성 Theater의 파일을 탐색·필터링하고 파일 선택 시 패널을 트리 옆의 크기 조절 가능한 파일 보기로 분할하는 File Explorer 도구를 추가합니다. 여기에는 구문 강조 코드, 렌더링된 markdown, 이미지 미리보기, 바이너리 폴백이 제공되며, 큰 트리도 행 가상화로 매끄럽게 유지됩니다.
- [fleet-console] 활성 Theater의 변경 파일을 나열하고 해당 unified diff를 보여 주며, working-tree 변경과 staged 변경 사이를 전환할 수 있는 Diff 도구를 추가합니다.
- [fleet-console] 이제 Fleet Console은 `~/.fleet/plugins` 아래에 설치된 서드파티 client plugin을 검색하고 로드하여, 내장 Terminal과 함께 해당 Operation 패널 및 Settings 섹션을 렌더링합니다.
- [fleet-console] 플러그인은 호환성을 위해 `apiVersion`을 선언하며, 호환되지 않거나 실패한 외부 플러그인은 console을 중단시키지 않고 건너뜁니다.
- [fleet-console] 외부 플러그인 client 코드는 런타임 shim을 통해 console의 React 및 SDK singleton을 공유하며, 플러그인 route는 전용 `/plugin-runtime/` endpoint 아래의 host Node process에서 실행됩니다.
- [fleet-console] 왼쪽 Operations SideBar에서 Operation 이름을 더블 클릭하여 직접 이름을 바꿉니다.
- [fleet-console] 이제 Operations SideBar는 이름 있는 group을 지원합니다. 오른쪽 클릭 메뉴로 group을 생성·이름 변경·색상 변경·해제하고, chip을 group 사이로 드래그하며, group의 구성원 chip을 접거나 펼칠 수 있습니다. group 멤버십은 accent 및 in-progress 상태 채널과 독립적으로 유지되는 색상 rail로 표시됩니다.
- [fleet-console] 실행 상태 신호를 유지하면서 Operation 패널 pulse animation을 켜거나 끌 수 있는 side bar 지도 설정을 추가했습니다.
- [fleet-console] 왼쪽 Operations SideBar의 빈 영역을 오른쪽 클릭하면 New Operation 버튼과 동일한 overlay인 New Operation launcher가 커서 위치에서 열립니다.

### Changed
- [fleet-console] 패널 제목 표시줄 또는 side bar 항목의 상태 표시기를 클릭해 Operation의 accent color를 설정하면 색상 popover가 열립니다. 전용 accent 버튼은 제거되었으며, side bar 표시기를 클릭하면 최소화된 Operation을 포함한 모든 Operation에 accent를 지정할 수 있습니다.
- [fleet-console] 이제 Operation의 accent color는 side bar 항목뿐 아니라 canvas 패널에도 윤곽선을 표시합니다. 선택한 색조로 focus outline을 대체하며 Operation이 focus·running·awaiting·minimized 상태인지와 관계없이 계속 보입니다.
- [fleet-console] 이제 캐리어 출력은 별도의 child streaming 패널을 생성하는 대신 Agent 패널 안에서 상단의 요약 banner로 streaming되며, 클릭하면 상세 modal이 열립니다.
- [fleet-console] Codex는 내장 패널로 오른쪽 rail로 이동합니다. /console/codex 전체 route, side-overlay edge handle 및 codex view-mode toggle은 제거됩니다.
- [fleet-console] Codex client는 더 이상 browser history를 변경하거나 URL을 읽지 않으며, workspace 선택은 Theater state가 제어합니다.
- [fleet-console] Codex server는 admin workspace registration endpoint와 bearer-token surface를 제거합니다. Theater registration과 restart restoration만 남은 mount path입니다.
- [fleet-console] 독립형 fleet-wiki CLI가 제거되었으며, Codex는 이제 Theater 범위의 오른쪽 rail 패널로만 진입합니다.
- [fleet-console] 오른쪽 rail에 맞게 Codex knowledge 패널을 재설계했습니다. 조밀한 3-pane layout 대신 간결한 단일 열 navigator(검색, 항목 목록, Drydock badge, conflicts)를 사용합니다. 항목을 선택하면 inline 2-pane split이 열려 왼쪽에는 문서가, 오른쪽에는 계속 탐색 가능한 navigator가 표시되며, Expand control은 목차 rail이 있는 중앙의 편안하게 넓은 읽기 overlay를 엽니다. Codex markdown 읽기 스타일은 전체에서 유지됩니다.
- [fleet-console] Codex backend를 4개의 REST resource(search, entry, drydock, conflicts)로 간소화했습니다. 이제 원본 source는 entry response에 포함되며, 폐기된 endpoint는 404를 반환합니다.
- [fleet-console] 하단 Operations taskbar와 canvas launcher 버튼을, 종류 아이콘으로 모든 열린 Operation을 세로로 나열하는 접기·크기 조절 가능한 왼쪽 side bar로 교체했습니다. chip을 클릭해 패널에 focus하고(chip을 오른쪽 클릭해 accent colour 설정), 드래그하거나 Alt+Shift+Up/Down으로 순서를 변경하며, "+ New" 버튼으로 Operation을 생성할 수 있습니다. "+ New" 옆 settings 버튼에는 map fullscreen, radar sweep, panel pulse 및 keyboard-shortcut reference가 있으며, "+ New"와 settings 메뉴는 해당 버튼 옆 overlay로 열립니다. side bar 너비와 접힌 상태는 browser별로 유지되며, 가장 좁을 때는 bar가 중앙 정렬 아이콘 rail로 접힙니다.
- [fleet-console] 이제 오른쪽 Activity Rail과 File Explorer 및 Diff 분할 패널은 크기 조절 중 포인터를 즉시 따라가며, cursor 뒤에서 완화되어 드래그가 멈춘 뒤에야 따라잡지 않습니다.
- [fleet-console] ambient radar sweep와 panel pulse animation은 이제 console이 로컬 미게시 build(`pnpm`)에서 실행될 때 기본적으로 꺼져 개발 재시작 시 조용하게 시작합니다. 게시된 build에서는 기본적으로 켜져 있으며, 명시적인 browser별 toggle preference는 항상 채널 기본값보다 우선합니다.
- [fleet-console] 이제 Diff 패널은 선택한 폴더가 Git repository가 아니거나 Git을 사용할 수 없을 때 이해하기 쉬운 영어 메시지를 표시하며, 난해한 raw error를 표시하지 않습니다.
- [fleet-console] 이제 모든 File Explorer 패널 텍스트는 영어입니다.
- [fleet-console] 이제 모든 console backend route는 통합된 `/api/v1` prefix 아래에서 제공되며, settings는 `/api/v1/settings/*` 아래로, updates는 `/api/v1/updates/*` 아래로 통합됩니다.
- [fleet-console] 이제 캐리어 settings는 4개의 개별 단일 필드 mutation route 대신 단일 `PATCH /api/v1/settings/carriers/:id` endpoint를 통해 부분 업데이트를 허용합니다.
- [fleet-console] Console Settings General(theme 및 console port)은 이제 console data directory에 server-side로 저장됩니다. 선택한 theme는 browser 간에 공유되고 browser별로만 기억되던 이전과 달리 restart 후에도 유지됩니다.
- [fleet-console] 이제 Settings는 console 소유 control과 플러그인 소유 control을 별도로 group화하며, 독립적인 Terminal Agent CLI 섹션에서 system prompt control, model sign-in 및 CLI availability를 통합합니다.
- [fleet-console] Appearance settings를 General로 병합합니다(Theme card + Console Port card). Settings 왼쪽 rail에서 Appearance nav 항목을 제거합니다.
- [fleet-console] Terminal Font 및 Terminal Renderer settings를 core에서 Terminal plugin으로 이동합니다. 이제 Agent CLI settings 섹션이 이 두 card를 소유하며, 모든 terminal 패널은 module-scoped store를 통해 즉시 반응합니다.
- [fleet-console] 이제 Fleet Console self-update는 활성 terminal session과 관계없이 즉시 적용됩니다. terminal session에 live PTY가 있어도 더 이상 업데이트가 차단되지 않습니다.
- [fleet-console] 이제 Diff 및 File Explorer rail 패널은 core console server route 대신 독립적인 플러그인 로컬 backend route(`/plugins/diff/*`, `/plugins/file-explorer/files/*`)를 사용하여 플러그인 platform architecture를 완성합니다.
- [fleet-console] 이제 Diff 패널은 staged 및 unstaged 변경을 동시에 보이는 두 개의 접을 수 있는 섹션(VS Code Source Control 스타일)으로 표시하고, 이전에 보이지 않던 새로 생성된(untracked) 파일을 표시하며, 플러그인 소유 toolbar에 List / Tree 보기 toggle을 추가합니다.
- [fleet-console] 이제 Diff 패널의 file-tree 및 hunk 보기는 드래그 가능한 divider로 분리되며, 분할 비율은 browser별로 유지됩니다.
- [fleet-console] Codex 읽기와 내장 플러그인 preview가 하나의 구현을 공유하도록 공용 markdown renderer와 Mermaid hydrator를 `@fleet-console/markdown` workspace package로 추출합니다.
- [fleet-console] 이제 file-explorer `.md` preview는 Codex와 동일한 markdown engine 및 style(GFM, syntax highlighting, Mermaid diagram, code toolbar)을 사용합니다.
- [fleet-console] 이제 File Explorer는 영구적인 2-pane split(왼쪽 preview, 오른쪽 tree)으로 열리고 파일을 선택하지 않았을 때 placeholder를 표시하며, 활성화된 동안 activity rail slot을 넓히고 Theater 전환 시 세션 내 preview와 분할 위치를 유지합니다.
- [fleet-console] 이제 File Explorer는 이전의 단일 색상 glyph를 대체하여 code, data, style, document, image, shell, config, database, archive, binary 파일 전반에 걸쳐 서로 다른 형태와 언어별 색상을 갖는 다채로운 파일 유형별 아이콘을 표시합니다. 이제 directory는 일반 disclosure chevron 대신 열림/닫힘 folder icon을 사용하고, 잘 알려진 folder(예: src, test, node_modules, dist, docs, .git)에는 accent color를 적용합니다. 전체 icon palette는 활성 Maritime 또는 Carbon theme에 맞춰집니다.
- [fleet-console] Operation 상태 표시기를 개편했습니다. 사용하지 않는 live 상태를 제거하여 이제 캐리어 streaming은 running으로 표시됩니다.
- [fleet-console] Operation 상태 색상을 변경했습니다. 이제 awaiting은 aurora(teal)이고 idle은 green이며, idle 패널은 더 이상 perimeter를 animation하지 않습니다.
- [fleet-console] Agent turn이 끝난 Operation은 캐리어 job이 여전히 streaming 중이면 running 표시기를 유지하고, streaming이 완료되면 idle로 전환됩니다.
- [fleet-console] Operation이 idle 또는 awaiting으로 전환되면 alert를 발생시킵니다.
- [fleet-console] 이제 Terminal 세션 패널은 제목에 `#N` 순번을 덧붙이지 않으므로, 동일한 Theater의 여러 세션이 같은 이름을 공유할 수 있습니다.
- [fleet-console] 이전 console 버전에서 저장한 Theater와 terminal session은 이제 upgrade 시 초기화되지 않고 자동으로 migration되어 보존됩니다.
- [fleet-console] parent/child Operation tree 개념을 제거했습니다. 이제 Operations canvas는 command tether를 렌더링하지 않으며 모든 Operation은 최상위 항목입니다.
- [fleet-console] Console durable state를 단일 `operations` collection으로 단순화했습니다. on-disk schema는 migration path 없이 상향되므로, 기존 `state.json` 파일은 첫 boot 시 초기화되고 이전에 등록된 Theater와 Operation은 잊힙니다.
- [fleet-console] operations contract 변경에 따라 플러그인 SDK API version을 상향했습니다. 따라서 이전 SDK를 대상으로 build된 외부 플러그인은 이제 런타임에서 실패하는 대신 호환되지 않는 것으로 거부됩니다.
- [fleet-console] 이제 Operations 왼쪽 sidebar의 Operation group은 작은 항목별 색상 stub 대신 group 왼쪽 가장자리를 따라 이어지는 연속 색상 rail과 색조가 있는 group header로 표시되므로, group이 한눈에 경계가 있는 하나의 묶음으로 읽힙니다.
- [fleet-console] Theater folder 선택을 console로 이동하는 한편, Terminal 플러그인 세션, ticket 및 WebSocket transport를 Shell 및 Agent operation에 맞게 독립적으로 구성했습니다.
- [fleet-console] 외부 플러그인 API compatibility version을 1로 재설정했습니다. 이제 내장 플러그인 manifest는 이에 맞춰 apiVersion 1을 선언합니다.
- [fleet-console] console durable state schema version을 2로 재설정했습니다.

### Fixed
- [fleet-console] 이제 Agent operation 패널은 이전에 패널을 inactive 상태로 두었던 AskUserQuestion prompt를 포함하여 모든 input-waiting hook event에서 awaiting 상태가 됩니다. idle prompt는 더 이상 blocking signal로 처리되지 않습니다.
- [fleet-console] 이제 ALERTS는 현재 보고 있는 operation을 제외한 모든 operation에 대해 Theater 또는 minimized/maximized 상태와 관계없이 Awaiting 및 Complete notification을 표시합니다. 이전에는 Operations canvas가 열려 있는 동안 모든 operation의 notification이 억제되어 rail이 비어 있었습니다.
- [fleet-console] Operation 패널이 maximized 상태일 때 ALERTS의 alert 또는 Operation quick-search의 result를 열면 maximized 보기를 유지한 채 target Operation으로 전환하며, maximized 보기가 접히지 않습니다.
- [fleet-console] 패널이 maximized 상태일 때 새 Operation을 생성하면 maximized 보기가 유지되고 새 패널이 maximized 패널이 되며, maximized 보기에서 벗어나지 않습니다.
- [fleet-console] 전역 설치된 Fleet Console이 React module 누락 오류로 시작하지 못하던 문제를 수정했습니다. 이제 게시된 package는 다시 독립적으로 구성되어 npm install 후 console과 내장 플러그인이 올바르게 로드됩니다.
- [fleet-console] 이제 Alt+Left/Right로 Operation을 순환하면 고정된 생성 시점 순서 대신 수동 드래그 재정렬을 포함해 Operations side bar에 표시된 순서를 따르므로, 예상한 패널로 focus가 이동합니다.
- [fleet-console] 이제 Operations canvas surface(map background 및 sea wash)는 Maritime palette로 고정되지 않고 활성 theme를 따르므로 Carbon theme는 중립적인 어두운 canvas로 렌더링됩니다. Maritime appearance는 변경되지 않습니다.
- [fleet-console] 이제 Operations canvas radar sweep는 Radar sweep이 활성화되면 Panel pulse가 켜져 있어야 했던 이전과 달리 항상 animation됩니다. Panel pulse는 나머지 ambient animation을 독립적으로 제어합니다.
- [fleet-console] 이제 Operations Left SideBar에서 Operation 이름을 더블 클릭하면 inline rename editor가 안정적으로 열립니다.

### Removed
- [fleet-cli] Mission Control Wiki Server 패널 및 `fleet wiki` subcommand를 제거했습니다. 이들이 중계하던 독립형 fleet-wiki binary는 폐기되었습니다.
- [fleet-cli] 번들된 `fleet-wiki` package는 MCP 런타임 및 Mission Control status line에서 사용하는 wiki tool spec과 항목 수를 위해 유지됩니다.

## [1.15.0] - 2026-06-26

### Added
- [fleet-console][fleet-infra] 선택한 port를 사용할 수 없을 때 dynamic port로 자동 폴백하고 Settings feedback을 제공하는, static console port 고정용 Settings -> General control을 추가합니다.

### Changed
- [fleet-console] in-progress operation은 이제 canvas 패널과 dock chip에서 동시에 running-light perimeter ring을 animation하지 않습니다. rotating ring은 패널이 보이는 동안 canvas 패널에 표시되고, 패널이 minimized 상태일 때만 dock chip에 표시되어 GPU 사용량을 낮춥니다. dock chip은 두 경우 모두 progress glow와 beacon을 유지합니다.

## [1.14.0] - 2026-06-26

### Added
- [fleet-console] 열려 있는 모든 terminal에 즉시 적용되는 browser별 terminal font family 및 size control을 추가했습니다.

### Fixed
- [fleet-console] Theater 간에 maximized Operation 패널 상태를 독립적으로 유지합니다.

## [1.13.0] - 2026-06-25

### Added
- [fleet-console] browser tab과 bookmark에서 console에 고유 icon이 표시되도록 favicon을 추가합니다.
- [fleet-console] chip을 새 위치로 드래그하거나 chip에 focus된 상태에서 Alt+Shift+Arrow를 사용해 dock taskbar 패널을 재정렬할 수 있으며, 배치는 Theater별로 유지됩니다.
- [fleet-console] 16-color palette에서 사용자 지정 accent color로 dock taskbar 패널을 표시합니다. system status signal은 그대로 유지하면서 색상이 전체 패널 perimeter(in-progress indicator가 표시되는 동일한 가장자리)를 두르며, 선택은 Theater별로 유지됩니다.

### Changed
- [fleet-console] 이제 Dock taskbar를 닫으려면 두 번째 확인 클릭이 필요하여 실수로 패널이 제거되는 것을 방지합니다.

### Fixed
- [fleet-admiral] Codex CLI 실행이 Codex 0.142.0 이상에서 더 이상 시작에 실패하지 않습니다. Fleet이 최신 버전에서 제거된 Codex feature flag를 전달해 Codex가 시작 시 중단되던 문제를 해결했습니다.

## [1.12.0] - 2026-06-23

### Added
- [fleet-console] 이제 Theater directory browser는 drive rail(C:, D: 등)을 통해 다른 drive에 접근하고 direct path input으로 absolute path로 바로 이동할 수 있어 home drive 밖의 project를 등록할 수 있습니다. picker도 더 많은 folder가 보이도록 확대했습니다.

### Fixed
- [fleet-console] 패널이 maximized 상태일 때 launcher에서 새 Operation 또는 shell 패널을 추가해도 maximized mode를 유지합니다. 새로 생성된 패널은 maximized mode를 종료하는 대신 maximized overlay를 이어받습니다.

## [1.11.0] - 2026-06-23

### Changed
- [fleet-console] 이제 Operations dock taskbar에는 minimized 패널뿐 아니라 모든 열린 패널을 표시하고, 현재 focus된 패널의 chip을 강조합니다. chip을 클릭하면 해당 패널을 앞으로 가져오며, 패널이 maximized 상태이면 maximized mode를 유지합니다.
- [fleet-console] chip pager가 너무 일찍 표시되지 않도록 Operations dock taskbar를 radar minimap까지 넓힙니다.
- [fleet-console] Operations canvas의 왼쪽 아래에 새 패널 메뉴를 여는 "+" launcher 버튼을 추가하며, 패널이 maximized 상태일 때도 사용할 수 있습니다.
- [fleet-console] Alerts notification toggle 및 패널을 Codex side handle 위의 오른쪽 가장자리로 이동합니다.
- [fleet-console] 패널이 maximized 상태일 때 floating canvas control(minimap, shortcut, fullscreen 및 background-animation toggle)을 숨기고, maximized 패널의 maximize 버튼을 강조합니다.
- [fleet-console] Operations canvas 패널을 persistent taskbar, 패널 maximize, Shell parity 및 안정적인 패널 순환을 갖춘 OS 스타일 window system으로 개편했습니다.

## [1.10.2] - 2026-06-21

### Changed
- [fleet-console] 이미 활성화된 Carriers 또는 Settings navigation 버튼을 클릭하면 이제 Operations canvas로 돌아갑니다.
- [fleet-console] 이제 What's new는 server-proxied main changelog에서 모든 릴리스 노트를 런타임에 로드합니다.
- [fleet-console] 이제 What's new version selector는 이전/다음 pagination과 함께 페이지당 10개의 release를 표시합니다.

## [1.10.1] - 2026-06-21

### Fixed
- [fleet-console] 이제 Settings 페이지의 모든 backend API catalog 설명은 영어로 표시되며, 남아 있던 한국어 항목을 번역했습니다.

## [1.10.0] - 2026-06-21

### Added
- [fleet-console] 이제 Settings는 backend introspection에서 동적으로 채워지는 접을 수 있는 card에 console의 backend HTTP API catalog를 나열하므로, 새로 추가된 route가 자동으로 표시됩니다.
- [fleet-console] 이제 접힌 Alerts dock은 새 alert가 도착하면 1회성 outline pulse를 재생하여 dock을 펼치지 않고 주변 시야 feedback을 제공합니다. pulse color는 alert state(awaiting은 amber, completed는 emerald)를 따르며 활성 theme에 맞춰집니다.
- [fleet-console] 이제 Canvas-mode operation은 패널이 minimized 상태가 아닐 때도 Alerts를 발생시키므로, 보이는 canvas 패널이 더 이상 자체 alert를 억제하지 않습니다.
- [fleet-carriers] 이제 carrier_dispatch는 선택적 absolute `cwd` 인수를 허용하므로, 위임된 캐리어의 CLI가 항상 host 세션 directory에서 실행되는 대신 지정된 working directory(예: git 워크트리)에서 실행됩니다.

### Changed
- [fleet-console] root path `/` 및 알 수 없는 path는 이제 `/operations`로 redirect됩니다.
- [fleet-console] 이제 console version은 top-bar "Research Preview" label 아래에 표시됩니다.
- [fleet-console] 이제 commissioning guide는 첫 방문 시에만 자동으로 나타납니다.
- [fleet-console] 이제 Alerts notification dock은 바깥 클릭, Escape 및 다른 Operation으로 이동할 때 접힙니다.
- [fleet-console] 이제 Settings는 Agent CLI 아래에 Model Sign-in을 group화하고 Backend API 섹션을 기본적으로 펼친 2-pane master-detail layout입니다.
- [fleet-console] 이제 Settings 페이지에 표시되는 backend API catalog 설명은 영어입니다.

### Removed
- [fleet-console] Welcome dashboard 페이지를 제거했습니다. 이제 Operations가 유일한 진입 surface입니다.
- [fleet-console] global navigation bar에서 Operation 및 Codex navigation 항목을 제거했습니다. 이제 Codex는 오른쪽 가장자리 Side handle로만 접근합니다.
- [fleet-console] top bar에서 Research Preview indicator dot을 제거했습니다.
- [fleet-console] Helm(classic) Operations mode와 Map/Helm view toggle을 제거했습니다. 이제 Operations 보기는 단일 Map canvas입니다.
- [fleet-console] Operations 왼쪽 sidebar(classic fixed 세션 list 및 Map floating 세션 list)를 제거했습니다.
- [fleet-console] global navigation Shell 버튼, 해당 overlay 및 local-shell keyboard shortcut을 제거했습니다. in-canvas shell 패널은 계속 사용할 수 있습니다.

## [1.9.0] - 2026-06-20

### Added
- [fleet-console] Fleet Console에 Moonshot Kimi부터 시작해 캐리어가 해당 모델에서 실행될 수 있도록 provider API key를 등록, 검증, 삭제하는 Model Sign-in 섹션을 전역 Settings 화면에 추가했습니다. 키는 provider에서 검증하고 로컬에 저장하며 브라우저에 다시 표시하지 않습니다.
- [fleet-console] npm을 통해 Fleet Console을 전역 설치하면 설치 완료 시 이제 자동으로 브라우저에서 console을 엽니다. 대화형 데스크톱 설치로 한정되며 CI, headless 또는 비전역 설치에서는 건너뜁니다. 원하지 않으면 `FLEET_CONSOLE_NO_AUTO_OPEN`를 설정하세요.
- [core-unified-agent][fleet-admiral][fleet-infra][fleet-cli] `fleet auth` 로그인/로그아웃 지원을 포함해 CLI와 Console 전반에서 선택 가능한 Claude 계열 provider로 Claude GLM (ZhipuAI GLM)을 추가했습니다.
- [fleet-console] 이제 Settings의 Model Sign-in 섹션에서 Moonshot Kimi와 함께 ZhipuAI GLM도 표시하여 Console에서 직접 API key를 등록, 검증 및 로그아웃할 수 있습니다.
- [fleet-console] 이제 Settings에서 각 Agent CLI (Claude Code, Codex CLI, OpenCode, Cursor Agent)의 설치 여부와 감지된 버전을 표시합니다.
- [fleet-console] Codex가 아닌 모든 뷰에서 오른쪽 가장자리 핸들로 Codex Side 패널을 열 수 있습니다.
- [fleet-console] Codex Side 패널 헤더에서 왼쪽 (Nav) 및 오른쪽 (ToC/Manifest) 창을 수동으로 접을 수 있습니다.
- [fleet-console] Side 뷰에서 Codex Cmd+K 검색 팔레트는 전체 화면을 덮는 대신 Side 패널 영역으로 범위가 제한됩니다.
- [fleet-console] Codex Wiki 읽기 뷰는 본문을 단일 읽기 폭으로 제한하고 넓은 화면의 낭비되는 여백을 되찾으며, 찾아보기 및 색인 뷰의 빈 레일을 없애고 raw source 뷰를 동일한 셸로 통합합니다.
- [fleet-console] Codex Wiki 읽기 레일은 접을 수 있는 manifest 위에 활성 섹션 강조 표시가 있는 목차를 먼저 나열하고, 좁은 viewport에는 목차 드로어를 추가하며, 항목에는 breadcrumb을 표시합니다.
- [fleet-console] Console 자체 업데이트 흐름은 이제 npm registry 링크를 여는 대신 상단바 버튼에서 전역 `fleet-cli` + `fleet-console` 업데이트를 직접 적용합니다.
- [fleet-console] 자체 업데이트는 terminal Operation에 활성 PTY가 있으면 차단하고 로컬/미게시 빌드는 거부한 뒤, 새 임의 loopback port에서 console을 재시작하고 새 브라우저 창으로 엽니다.
- [fleet-cli] CLI 업데이트 하위 시스템이 이제 CLI별 종료 및 메시징 수명 주기를 유지하면서 범용 core-agent package-updater 기반을 공유합니다.
- [core-agent] package-manager 감지, 전역 root 확인, 버전 확인, install 생성 및 수동 폴백 메시지를 위한 범용 전역 package updater factory를 추가했습니다.
- [fleet-console] Fleet Console은 이제 설치된 버전의 changelog 항목을 Added/Changed/Fixed/Removed별로 묶어 나열하는 What's new 팝업을 표시합니다. 버전 업데이트 후 한 번 자동으로 열리며 전역 navigation bar의 What's new 컨트롤에서 언제든 다시 열 수 있습니다.
- [fleet-console] GNB Research Preview 배지 옆에 GitHub repository 링크와 실시간 star 수를 추가했습니다.
- [fleet-console] 이제 Fleet Console Operations Map 패널을 접을 수 있는 하단 dock으로 최소화하고 dock 항목이나 복원 버튼을 두 번 클릭해 원래 위치와 크기로 복원할 수 있습니다. dock은 하나의 펼치기/접기 핸들로 접히며, 각 항목에는 패널의 상태 표시등, 이름, Agent CLI, 활성 job 수가 표시되고, 최소화된 패널이 바쁠 때 접힌 핸들과 항목 모두가 pulse합니다.
- [fleet-console] 이제 Operations는 제출한 각 prompt의 첫 번째 의미 있는 줄에서 자동으로 이름이 정해집니다(Claude 및 Codex 세션 모두). 따라서 새 Operation은 작업이 시작되면 더 이상 일반적인 "#N Operation"으로 남지 않습니다. 수동 이름 변경이 항상 우선하며 자동 이름 변경으로 덮어쓰지 않고, 이름을 지우면 다시 활성화됩니다.

### Changed
- [fleet-console] Fleet Console은 이제 해당 Operation에 캐리어 job이 실행 중이면 완료 toast를 표시하지 않습니다. 작업이 아직 진행 중이고 활성 Operation 패널에 이미 반영되기 때문입니다.
- [fleet-console] 실행 중인 Operation 주의 모션을 열린 패널과 최소화된 Dock 컨트롤 전반에서 일관된 테두리 신호로 교체했습니다.
- [fleet-console] 최소화된 Operation 레이블을 열린 패널 제목 타이포그래피에 맞췄습니다.
- [fleet-console] Operations Map 최소화 패널 dock은 이제 중앙 하단 핸들(위/아래 chevron)에서 위쪽으로 펼쳐집니다. 항목은 중앙 정렬되고 사용 가능한 화면 너비에 맞게 늘어나며(왼쪽 shortcut 및 오른쪽 radar instrument와 겹치지 않음), 이후 overflow는 페이지 표시기와 이전/다음 컨트롤 뒤로 페이지 처리하므로 항목 수가 변경되어도 기존 항목이 더 이상 이동하지 않습니다.
- [fleet-console] 바쁜 최소화 패널 항목은 바깥으로 퍼지는 호흡 pulse 대신 전체 윤곽을 따라 움직이는 running light로 진행 상태를 알리고, dock 핸들의 주의 애니메이션은 dock이 접혀 있을 때만 재생됩니다.
- [fleet-console] 이제 최소화된 operation은 dock chip의 아무 곳이나 한 번 클릭하면 복원되며(이전에는 두 번 클릭), 중복된 chip별 복원 버튼은 제거했습니다.
- [fleet-console] Operation 완료 및 입력 대기 알림은 이제 별도의 평면 toast 스택 대신 Theater별로 묶여 왼쪽에 dock된 notification 패널에 표시됩니다. 이 패널은 계속 사용할 수 있고 가장자리 핸들로 열거나 닫을 수 있으며, 현재 보이지 않는 Operations만 표시합니다.
- [fleet-console] notification cluster는 Operation별 완료와 입력 대기를 구분하고 반복된 입력 대기 주의를 집계하며, 전역 mute, do-not-disturb 및 Theater별 mute 컨트롤을 추가합니다.
- [fleet-console] cluster 알림은 Operation이 작업을 재개하면 자동으로 지워지고 해당 세션 또는 Theater가 삭제되면 제거되므로 오래된 행이 더 이상 남아 있지 않습니다.
- [fleet-console] 이제 Operation 시작 메뉴는 Agent CLI가 설치되지 않았거나 sign-in이 필요한 모델에 로그인하지 않았을 때 해당 Agent CLI 선택지를 비활성화하고, 비활성화된 각 선택지에 이유를 표시하며, server는 해당 CLI의 session 생성 요청을 거부합니다.
- [fleet-console] theme 선택 및 terminal renderer 컨트롤을 전역 navigation bar에서 Settings 화면 상단의 새 Appearance 섹션으로 옮겨 navigation bar를 정리했습니다. 둘 다 즉시 적용되며 브라우저별로 기억됩니다.

### Fixed
- [fleet-console] source에서 실행한 Fleet Console(`pnpm fleet-console`)은 이제 공유 home directory 대신 project workspace 아래에 지속되는 Theaters, Operations 및 세션 capture를 저장하므로 development console이 전역 설치된 Fleet Console과 상태를 더 이상 섞지 않습니다.
- [fleet-console] 이제 Operation 자동 이름 변경은 operator가 이름을 지워 자동 이름 변경을 다시 활성화하지 않는 한 첫 번째 제출 prompt에서만 업데이트됩니다.
- [fleet-console] dispatch된 캐리어 job이 아직 실행 중일 때 carrier-dispatch idle pause가 잘못된 "Awaiting orders" 알림을 발생시키지 않도록 했습니다. 실제 입력 대기 prompt(권한 요청, 질문, elicitation dialog)는 이전과 같이 계속 알립니다.
- [fleet-console] Map 뷰의 Operations sidebar 접힘 상태는 이제 Codex full mode로 이동했다가 돌아와도 확장 상태로 재설정되지 않고 유지됩니다.
- [fleet-console] Operations Map 패널 위치와 크기는 이제 기본값으로 재설정되지 않고 브라우저 새로고침 후에도 유지됩니다.
- [fleet-console] 이제 Map shell 패널은 브라우저 새로고침 후에도 사라지지 않고 유지됩니다.
- [fleet-console] 추가 terminal을 열거나 최소화된 terminal을 dock에서 복원할 때 다른 열린 Operations terminal에 깨진 화면이 표시되던 문제를 수정했습니다.
- [fleet-console] 이제 Operations Map terminal 내부의 마우스 클릭과 drag 선택은 map을 확대하거나 축소한 뒤 뷰를 재설정할 때까지 offset되는 대신 올바른 cell에 도달합니다.

### Removed
- [fleet-console] Fleet Console은 캐리어가 sortie할 때 더 이상 toast를 표시하지 않습니다. 활성 Operation 패널에 이미 활성 job이 반영되기 때문입니다.
- [fleet-admiral] Fleet은 더 이상 user-global (`~/.fleet`) 또는 project-local (`.fleet`) skills, agents 및 hooks를 Agent CLI 세션에 렌더링하지 않으며, 내장 Fleet 플러그인만 활성화됩니다.
- [fleet-admiral] launch 시 deprecated user-global 및 project 플러그인 등록과 남아 있는 marketplace directory를 Codex와 Fleet marketplace에서 정리합니다.
- [fleet-infra] [fleet-cli] [fleet-console] 이전 `~/.fleet/agent/auth.json` 위치에서 legacy auth credential을 자동으로 마이그레이션하는 기능을 제거했습니다. Fleet은 이제 `~/.fleet/auth.json`만 읽고 쓰므로 이전 위치에 남은 credential은 더 이상 인식되지 않으며 `fleet auth login`으로 다시 추가해야 합니다.

## [1.8.0] - 2026-06-18

### Added
- [fleet-console] Fleet Console은 처음 사용하는 operator에게 Theater 등록, Operation 열기 및 캐리어 관찰을 안내하는 commissioning walkthrough를 제공합니다. 이는 비어 있는 bridge를 처음 시작할 때 자동으로 표시되고 Welcome dashboard에서 언제든 다시 열 수 있으며, 비어 있는 Theater 상태에서 setup action으로도 표시됩니다.
- [fleet-console] Fleet Console은 기존에 Fleet CLI에서만 제공하던 옵션과 일치하게 system prompt injection mode(Append 또는 Replace)를 선택하고 naval metaphor tone overlay를 전환하는 전역 Settings 화면을 추가했습니다. 변경 사항은 새로 시작되는 세션에 적용됩니다.
- [fleet-console] Fleet Console은 background Claude Operation이 operator 입력을 위해 일시 중지되면 Theater와 Operation 이름 및 해당 위치로 이동하는 컨트롤을 포함한 전역 상단 중앙 toast를 표시합니다. sortie toast와 달리 닫을 때까지 유지되며 현재 보고 있는 Operation은 표시하지 않습니다.
- [fleet-console] Fleet Console Codex (Fleet Wiki) 화면은 이제 전체 페이지 route 외에도 현재 뷰 옆에 크기 조절 가능한 side 패널로 열 수 있습니다. navigation-bar 토글로 Full과 Side 간 전환하며 선택은 기억되고, 패널 크기는 자유롭게 조절할 수 있으며, 좁아지면 Codex 콘텐츠만 표시합니다.

### Changed
- [fleet-console] Fleet Console Operations Map fullscreen은 더 이상 Esc 키로 종료되지 않으며 이제 maximize/restore 컨트롤로만 종료할 수 있습니다.
- [fleet-console] Fleet Console 전역 navigation bar는 이제 전역 Settings와 캐리어별 설정을 분리하여 기존 캐리어 항목을 "Carriers"로 이름을 바꾸고 전용 "Settings" 항목을 추가합니다.

### Removed
- [fleet-console] Fleet Console Operations Map 패널 title bar에는 더 이상 패널을 맞게 확대하는 focus 버튼이 없으며, 동일한 확대를 실행하던 title-bar 두 번 클릭도 함께 제거했습니다.

### Fixed
- [fleet-console] Fleet Console은 이제 console 재시작 후에도 Theater의 Codex (Fleet Wiki) 뷰를 계속 사용할 수 있게 합니다. 이전에는 wiki data가 있는 Theater도 재시작 후 제거했다가 다시 추가하기 전까지 Codex가 없는 것처럼 잘못 표시되었습니다.

## [1.7.1] - 2026-06-17

Release v1.7.1

## [1.7.0] - 2026-06-17

### Added
- [fleet-console] Fleet Console Operations Map은 이제 보간된 wheel zoom으로 부드럽게 확대/축소되며 panning은 즉시 유지됩니다.
- [fleet-console] Fleet Console Operations Map은 활성 Theater의 directory에서 일반 user-shell terminal 패널을 열 수 있습니다. 하나를 활성화하면 Operation 패널처럼 앞으로 가져오고 활성 패널로 강조하며, Operations로 추적되거나 reload 후에도 유지되지 않습니다.
- [fleet-console] Fleet Console Operations Map은 cursor 위치에서 새 Operation을 시작하고 shell을 열거나 뷰를 재설정하는 right-click canvas 메뉴를 추가했습니다.
- [fleet-console] 이제 Fleet Console Operations Map 패널은 focus 버튼 외에도 title bar의 빈 영역을 두 번 클릭하여 focus할 수 있습니다.
- [fleet-console] 이제 Fleet Console Operations Map 패널은 Operations 목록과 동일한 이름 변경 흐름을 재사용하여 패널 이름을 두 번 클릭해 inline으로 이름을 변경할 수 있습니다.
- [fleet-console] Fleet Console Operations Map은 모든 패널과 현재 viewport를 표시하는 오른쪽 하단 minimap을 추가했습니다. 이는 canvas 탐색을 위해 drag할 수 있고, 접어서 오른쪽 하단의 단일 버튼으로 만들 수 있으며 클릭하면 복원됩니다.
- [fleet-console] Fleet Console Operations는 활성 Theater 내에서 이전/다음 Operation에 focus하는 Alt+Left / Alt+Right를 추가하며 Map 및 Helm 뷰 모두에서 작동합니다.
- [fleet-console] Fleet Console Operations Map은 "?" 버튼으로 접히는 접을 수 있는 왼쪽 하단 shortcut reference 패널을 추가했습니다.
- [fleet-console] Fleet Console Operations Map은 radar 토글 옆에 애니메이션과 함께 전역 navigation bar를 숨기고 Operations sidebar를 자동으로 접는 maximize 컨트롤을 추가했습니다. 컨트롤 또는 Esc로 종료하며 브라우저별로 기억됩니다.
- [fleet-console] Fleet Console Operation indicator는 이제 활성 Agent CLI turn 상태를 반영합니다. 첫 turn 전에는 grey, agent가 turn을 처리하는 동안에는 amber, turn이 끝나면 green, 캐리어 job이 실행 중일 때는 기존 live colour를 표시합니다.
- [fleet-console] Fleet Console은 background Operation이 캐리어 sortie를 보고하거나 stands down할 때 Theater와 Operation 이름 및 해당 위치로 이동하는 Go 컨트롤을 포함한 전역 상단 중앙 toast를 표시합니다. 닫을 때 또는 10초 후 사라지며 현재 보고 있는 Operation은 표시하지 않습니다.

### Changed
- [fleet-console] Fleet Console은 이제 Theater와 workspace folder 선택에 in-console directory browser를 사용합니다. breadcrumb path 탐색, 입력 필터, 완전한 키보드 탐색 및 한 번 클릭으로 하위 폴더 진입을 갖춘 집중된 단일 열 folder 목록으로 OS-native folder dialog(PowerShell/COM, osascript, zenity/kdialog, WSL)를 대체하며, 원격 및 headless 브라우저 세션에서도 folder 탐색이 작동합니다.
- [fleet-console] Fleet Console Operations radar sweep 애니메이션은 이제 CPU를 훨씬 적게 사용하고 브라우저 tab이 숨겨지면 자동으로 일시 중지됩니다.
- [fleet-console] Fleet Console Operations Map은 이제 진행 중인 각 패널의 캐리어 job stream을 패널 위가 아닌 아래에 표시합니다.
- [fleet-console] Fleet Console Operations Map sidebar를 접으면 이제 전체 패널이 숨겨지고 왼쪽 가장자리에는 고정된 펼치기 컨트롤만 남습니다.

### Fixed
- [fleet-console] Fleet Console 전역 navigation bar는 더 이상 좁은 창 너비에서 toolbar와 중앙 Theater selector가 겹치지 않습니다. 창이 줄어들면 toolbar는 레이블을 점진적으로 icon으로 접고 두 번째 행으로 줄바꿈하여 Theater selector를 중앙에 유지합니다.
- [fleet-console] Fleet Console Theater를 잊는 작업은 이제 Theater의 directory가 이미 삭제되었거나 Theater가 더 이상 등록되어 있지 않아도 항상 성공하고 목록에서 제거하며, "Not Found" 오류로 실패하지 않습니다.

## [1.6.0] - 2026-06-16

### Added
- [fleet-console] 각 캐리어의 CLI, model, SubAgent mode, Task Force backend 및 display name을 편집하고 캐리어별 단일 save로 저장하는 Fleet Console 캐리어 설정 페이지를 추가했습니다.
- [fleet-console] Fleet Console Operations는 이제 활성 operation 세션을 배치하는 자유형 terminal canvas로 열립니다.
- [fleet-console] Fleet Console Operations canvas에는 operator가 켜거나 끌 수 있고 브라우저별로 기억되는 ambient radar sweep가 있는 어두운 심해 배경이 추가되었습니다.
- [fleet-console] Fleet Console Operations는 자유 배치 terminal canvas(Map)와 고전적인 고정 sidebar 단일 terminal 레이아웃(Helm) 사이를 전환하는 Map/Helm 뷰 토글을 추가했으며 브라우저별로 기억됩니다.
- [fleet-console] Fleet Console Operations Map은 이제 진행 중인 각 패널의 캐리어 job stream을 terminal 위에 띄우며, 선택하면 전체 캐리어 stream을 여는 실시간 stream-line preview를 제공합니다.
- [core-unified-agent] Claude provider의 선택 가능한 model 목록에 명시적인 Claude Opus 4.7 [1M] 및 Opus 4.8 [1M] model을 추가했습니다.
- [fleet-console] Fleet Console은 이제 Cmd/Ctrl+K로 console 전체 Operation quick-search를 제공하여 모든 Theater를 검색하고 선택한 Operation의 Theater 및 Operations route로 전환한 뒤 Map canvas를 해당 Operation의 패널로 확대하고 입력을 위해 terminal에 focus합니다. /codex path에서는 shortcut이 Codex 자체 검색에 우선권을 줍니다.
- [fleet-console] Fleet Console 전역 navigation bar에는 모든 console, Operations 및 Codex shortcut과 각각의 짧은 설명을 나열하는 reference map을 여는 keyboard-shortcuts 버튼이 추가되었습니다.
- [fleet-console] Fleet Console은 이제 캐리어 완료 reminder와 동일한 terminal prompt injection path를 재사용하여 해당 세션의 terminal에 `/rename <name>` slash command를 주입함으로써 Operation 이름 변경을 실행 중인 Agent CLI와 동기화합니다.
- [fleet-console] 재시작 후에도 Fleet Console theaters와 operations를 유지하고 열 때 dormant agent CLI 세션을 지연 재개합니다.

### Changed
- [fleet-admiral] Agent CLI 세션은 이제 기본적으로 Admiral system prompt를 CLI의 native system prompt에 대체하는 대신 추가합니다. fleet-cli의 System prompt 옵션으로는 여전히 replace mode로 다시 전환할 수 있습니다.
- [fleet-console] Fleet Console은 이제 source(pnpm/dev)에서 실행될 때 OS temp directory 대신 project의 `.fleet/console` 아래에 런타임 directory를 격리합니다. 명시적인 `FLEET_CONSOLE_DIR`는 여전히 이를 재정의하며 published build는 변경되지 않습니다.

## [1.5.5] - 2026-06-15

### Added
- [fleet-console] Fleet Console Operations sidebar는 이제 새 terminal 세션을 시작할 때 operator가 실행할 Agent CLI(Claude, Claude Kimi 또는 Codex)를 선택할 수 있게 합니다.
- [fleet-console] Fleet Console terminal 세션은 이제 기존 fleet-cli 동작에 맞춰 캐리어 job 완료 reminder를 원래 세션의 Agent CLI에 전달합니다.
- [fleet-console] Fleet Console Operations는 이제 terminal을 전체 너비로 확장해 Operations sidebar를 숨길 수 있으며, 세션의 진행 중인 캐리어 job을 실시간 streaming 상태의 간결한 한 줄 행으로 오버레이합니다. 각 Operation은 탐색 및 reload 후에도 확장 상태를 기억합니다.

### Changed
- [fleet-console] Fleet Console terminal 세션은 이제 fleet-cli wrapper를 생성하는 대신 공유 fleet-admiral 런타임을 통해 Agent CLI를 시작합니다.

### Removed
- [fleet-cli][fleet-console][core-agent] `fleet --headless` flag와 Fleet Console fleet-cli registration channel을 제거했습니다. 이제 관찰은 console이 소유한 terminal 세션을 통해서만 가능합니다.
- [core-agent] public surface에서 공유 CLI registration contract를 제거했습니다.

## [1.5.4] - 2026-06-14

### Fixed
- [fleet-console] Fleet Console의 local shell overlay는 이제 닫았다가 다시 열어도 매번 새로운 shell을 시작하는 대신 실행 중인 shell, scrollback 및 working directory를 유지합니다.

## [1.5.3] - 2026-06-14

### Added
- [fleet-console][core-agent] Fleet Console은 이제 더 새 console 릴리스가 npm에 게시되면 전역 navigation bar에 "Update available" badge를 표시합니다.

### Changed
- [fleet-console] Fleet Console의 local shell overlay는 이제 고정된 최대값으로 제한되는 대신 console 너비의 80%를 차지하므로 넓은 display에서 더 이상 좁게 보이지 않습니다.

## [1.5.2] - 2026-06-14

### Fixed
- [fleet-console] Fleet Console job overlay는 더 이상 오른쪽 가장자리에서 콘텐츠를 clip하지 않습니다. 긴 tool-call label은 이제 ellipsis로 truncate되고 card 안에 유지됩니다.
- [fleet-console] npm 설치 stable package에서 시작할 때 Windows에서 Fleet Console terminal 세션이 시작하지 못하던 문제를 수정했습니다.
- [fleet-cli][fleet-console] 이제 `fleet update`는 재설치 전에 실행 중인 Fleet Console을 중지하므로 실행 중인 console이 이전 설치의 파일을 lock할 때 Windows에서 update가 간헐적으로 실패하지 않습니다.

## [1.5.1] - 2026-06-14

### Removed
- [fleet-admiral] redline 및 frontline protocol mode는 더 이상 workflow 시작 전에 working-branch isolation readiness 검사를 포함하지 않습니다.

### Fixed
- [fleet-console] Fleet Console은 이제 placeholder development version만 항상 표시하는 대신 실제 설치된 package version을 보고합니다.
- [fleet-console] Fleet Console은 브라우저 뷰 연결이 끊어져도 더 이상 terminal 세션을 종료하지 않습니다. 세션은 operation 전환 및 console-web 종료 후에도 유지되며, 명시적인 close, 기반 process 종료 또는 server shutdown에서만 종료됩니다.

## [1.5.0] - 2026-06-14

### Added
- [fleet-console] Fleet Console은 이제 상단 바에서 선택하는 프로젝트 루트 디렉터리인 Theater별로 Admiral 세션과 Codex wiki 컨텍스트를 구성하며, Operations에는 활성 Theater의 Admiral만 표시합니다.
- [fleet-console] 독립형 풀스택 제어 표면인 Fleet Console은 탐색 가능한 워크스페이스 및 작업 레일, 추론 접기와 인라인 tool-call 활동을 포함한 캐리어 출력의 매끄러운 점진적 스트리밍, 작업 완료 요약, 원시 이벤트 타임라인을 갖춘 자체 런타임 패키지로 제공됩니다.
- [fleet-console] Fleet Console은 이제 활성 Theater의 지휘 브리프, Operations 준비 상태, 등록된 Theater 전반의 기능 매트릭스를 표시하는 Theater 준비 상태 Bridge에서 열리며, 캐리어 스트리밍은 상단 바 탐색에서 접근 가능한 전용 Operations route에서 제공합니다.
- [fleet-console] Fleet Console은 이제 fleet-carriers read-model에서 가져온 Carrier Readiness Matrix를 표시합니다.
- [fleet-console] Fleet Console CLI에 로컬 console server를 관리하는 `start`, `stop`, `restart`, `status` 하위 명령, 다른 Fleet CLI와 일관된 배너 스타일 도움말, `pnpm fleet-console` 루트 스크립트가 추가되었으며, `fleet console`은 모든 하위 명령을 독립형 binary로 전달합니다.
- [fleet-console] Fleet Console에는 Cmd/Ctrl+` 또는 상단 바 shell 작업으로 열 수 있는 무료 로컬 shell terminal이 추가되었습니다. 이는 중앙 오버레이로 열리며 기존 console terminal stack 위에서 운영자 자신의 login shell을 실행합니다.
- [fleet-console] Fleet Console은 이제 공유 Console GNB 아래의 Codex/Fleet Wiki web surface를 소유하며, `fleet wiki` 및 `fleet-wiki` 호환 경로는 console 패키지를 통해 처리됩니다.
- [fleet-cli] 선택한 Agent CLI를 terminal-exclusive mode로 실행하는 `fleet --native` 부팅 옵션이 추가되었습니다. 키보드, 마우스, 드래그, 스크롤 이벤트를 child CLI에 네이티브로 전달하고 하단 Fleet PTY를 건너뛰며, 캐리어 작업이 완료되면 child 세션에 세션 중간 알림을 주입합니다.
- [fleet-cli][fleet-console] 세션을 실행 중인 Fleet Console에 등록하여 실시간 관찰하도록 선택하는 `fleet --headless` 플래그가 추가되었습니다.
- [fleet-console] Fleet은 이제 Fleet Console을 로컬 풀스택 제어 표면으로 실행하고 전역 gateway daemon을 제거하며 MCP 연결을 CLI별 in-process server로 되돌립니다.
- [core-agent] Fleet 런타임을 위한 공유 CLI 등록 계약과 범용 in-process MCP server primitives가 추가되었습니다.
- [fleet-console] Fleet Console의 Operations 사이드바에 이제 각 operation card마다 기본 세션을 종료하고 레일에서 제거하는 닫기 컨트롤이 있습니다.

### Changed
- [core-unified-agent] Moonshot Kimi를 사용하는 Claude Code는 이제 Kimi K2.7 coding model을 기본, slot-mapped 및 subagent model로 실행합니다.
- [fleet-console] Fleet Console server는 이제 고정 포트 대신 OS가 할당한 임의 loopback port에 바인딩하며, `fleet-console start`는 이미 실행 중이고 정상인 daemon을 오류를 내거나 두 번째 server를 생성하지 않고 브라우저에서 다시 엽니다.
- [fleet-console] Fleet Console은 이전 carbon-and-lime 외관을 대체하여 deep-water ink와 brass/aurora accents, serif display type, glass surfaces, codex motion으로 구성된 Fleet 전반의 해양 시각 정체성을 채택합니다.
- [fleet-console] Observability 이벤트는 이제 길이 메타데이터로 가리는 대신 이벤트별 보존 한도를 두고 캐리어 출력 텍스트를 메모리에 유지하므로 console이 실시간 스트림을 렌더링할 수 있으며, 노출은 loopback-only로 유지됩니다.
- [fleet-console] Fleet Console 등록은 이제 opt-in입니다. `--headless`로 시작한 fleet-cli 세션만 console에 등록되고, 일반 및 `--native` 실행은 더 이상 console 워크스페이스에 표시되지 않습니다.
- [fleet-console] Fleet Console의 Admirals 사이드바는 이제 console이 소유한 terminal 세션을 나열하며, 각 세션에는 등록 순서대로 캐리어 작업 이력이 표시됩니다. 작업을 선택하면 해당 세션의 terminal 위에 중앙 스트리밍 오버레이가 열려 작업 관리를 활성 terminal 세션 범위로 유지합니다.
- [fleet-console] Fleet Console은 이제 재연결 시 terminal 세션을 다시 생성하는 대신 기본 process가 종료되면 세션을 종료하고 Admirals 레일에서 제거합니다.
- [fleet-console] Fleet Console의 Admirals 레일은 이제 진행 중인 캐리어 작업을 완료된 작업보다 위에 나열하고, 완료된 작업에는 녹색 상태 표시기를 표시하며, 각 작업에는 업데이트 타임스탬프 대신 캐리어 이름과 상태를 표시합니다.
- [fleet-console] Fleet Console은 상단 바 connection chip을 브랜드 마크 alert로 대체합니다. console 연결이 끊어질 때만 console sigil이 빨간색으로 바뀌고 오른쪽 하단 toast가 표시되며, 둘 다 재연결 시 자동으로 해제됩니다.
- [core-agent] 이전에 `@dotobokuri/core-mcp-server`에 있던 범용 MCP registry, routing, tool snapshot primitives는 이제 `@dotobokuri/core-agent`가 소유합니다.
- [fleet-admiral] Admiral protocol-mode skills의 이름을 `protocol-baseline`, `protocol-midline`, `protocol-redline`, `protocol-frontline`으로, 보조 gap-audit skill의 이름을 `assumption-audit`로 변경하여 built-in skill identifiers에서 중복된 `fleet-` prefix를 제거했습니다.
- [fleet-console] Fleet Console의 native folder picker는 이제 native Windows와 WSL 모두에서 legacy folder-tree dialog 대신 최신 Windows Explorer 스타일 폴더 dialog(주소 표시줄, 검색, 경로 붙여넣기)를 열며, WSL에서는 Linux filesystem에서 시작하므로 경로를 입력하지 않고도 navigation pane에서 WSL 폴더에 접근할 수 있습니다.
- [fleet-console] Fleet Console 브라우저 payload는 더 이상 원시 working-directory 경로를 노출하지 않으며, observer Theater 및 workspace 행에는 이제 표시 label만 포함됩니다.
- [fleet-console] Fleet Console의 Operations 실행 (+) 컨트롤은 이제 vector plus mark가 있는 Theater selector의 glass-well instrument 스타일을 채택합니다.

### Removed
- [fleet-console] 독립형 `fleet-wiki-ui` 런타임 패키지를 제거했습니다. 이제 Fleet Wiki 탐색은 Fleet Console에서 제공합니다.
- [fleet-wiki][fleet-console] Codex/Fleet Wiki web surface에서 한국어/영어 언어 전환을 제거했습니다. 이제 인터페이스는 영어 전용입니다.
- [fleet-console] Fleet Console에서 브라우저 token gate를 제거했습니다. 로컬 loopback 접근에는 더 이상 전달된 observer 또는 terminal token이 필요하지 않지만, CLI ingest authentication과 terminal origin check는 계속 적용됩니다.
- [fleet-cli] raw-CLI Native 실행 모드를 제거했습니다. 이제 전용 CLI는 항상 Fleet persona가 주입된 상태로 실행됩니다.
- [fleet-cli] native 및 non-native 세션 모두에서 Fleet 전역 단축키(Ctrl+C, Ctrl+Q, Ctrl+T)와 MIRROR/DEDICATED input mode 전환을 제거했습니다. 이제 Fleet 종료는 launcher Exit 작업 또는 child CLI 종료를 통해 처리됩니다.
- [core-agent] `@dotobokuri/core-mcp-server` 워크스페이스 패키지를 제거했습니다. 소비자는 대신 `@dotobokuri/core-agent`에서 범용 MCP API를 import해야 합니다.

### Breaking Changes
- [core-agent] `@dotobokuri/core-mcp-server` 패키지는 더 이상 publish되거나 resolve되지 않습니다. import를 `@dotobokuri/core-agent`로 마이그레이션하십시오.

### Fixed
- [fleet-cli] Windows의 Claude Code는 이제 기본(non-native) 모드에서 terminal cursor를 표시하고 한국어/CJK IME 입력을 올바르게 받습니다. 이전에는 조합 중 cursor가 숨겨지고 불필요한 공백이 삽입되었습니다. cursor projection이 여전히 제대로 작동하지 않는 terminal에서는 `--disable-cursor-sync`를 전달하거나 `FLEET_CURSOR_SYNC=0`을 설정하여 제외할 수 있습니다.
- [fleet-console] Fleet Console은 이제 명시적으로 restart할 때까지 로컬 server health refresh 전반에서 활성 CLI 세션을 보존합니다.
- [fleet-wiki][fleet-console] agent CLI 세션이 시작될 때 Fleet Wiki web이 브라우저에서 자동으로 열리던 문제를 수정했습니다.
- [fleet-console] Fleet Console의 native folder picker가 이제 WSL에서 interop을 통해 Windows folder dialog를 열고 선택한 Windows 또는 WSL 경로를 네이티브 Linux 경로로 다시 변환하여 작동합니다.

## [1.4.0] - 2026-06-10

### Added
- [fleet-admiral] Protocol-mode skills가 이제 checkpoint 경계를 선언하고 정규화된 report tokens를 사용해 두 번의 보고 주기를 따릅니다.
- [fleet-admiral] 이제 protocol sync check가 protocol mode drift, 중복된 Downward Guard 문구, report-token 문법을 방지합니다.
- [fleet-admiral] 이제 Admiral 결과 무결성은 변경을 수행하는 캐리어 작업 결과를 수락하기 전에 artifact 검사를 요구합니다.
- [fleet-carriers] 캐리어 작업 결과에 이제 검사를 위한 best-effort 워크스페이스 변경 manifest가 포함됩니다.
- [fleet-wiki] Wiki 항목 작성은 이제 본문에서 중복된 선행 frontmatter를 자동으로 제거하며, `wiki_drydock`은 선택적인 `fix` parameter로 이 상태를 감지하여 opt-in 자동 정리를 제공합니다.

### Changed
- [fleet-admiral] Admiral prompt policy는 이제 실시간 캐리어 tool descriptions를 캐리어 요청 메커니즘의 권위로 취급합니다.
- [fleet-carriers] Carrier roster는 이제 선택적 prior-jobs context hint를 모든 캐리어 아래에 반복하지 않고 한 번만 표시합니다.
- [fleet-admiral] Context Confidence planning thresholds는 이제 protocol mode에 따라 조정되며, standard 작업에는 충분한 confidence가 필요합니다.
- [core-agent][core-unified-agent][fleet-infra][fleet-admiral][fleet-carriers][fleet-wiki][fleet-console][fleet-cli] 동작 변경 없이 모든 워크스페이스 패키지 전반에서 중복 helper를 통합하고 내부 module import cycle을 해결했습니다.
- [fleet-cli][fleet-console][fleet-wiki] 루트 구조 map, developer reference documents, bilingual README를 현재 워크스페이스 레이아웃과 public API에 맞게 재정렬했습니다.
- [core-unified-agent] npm에 실수로 publish되는 것을 방지하기 위해 패키지를 이제 private로 표시합니다.

### Fixed
- [fleet-console] 전역 `fleet-wiki` 명령은 이제 monorepo checkout 또는 git 워크트리 내부에서 호출될 때 원래 의도대로 repository-local build를 다시 실행합니다.
- [fleet-console] Web client request-failure 메시지는 이제 항상 한국어로 표시되는 대신 선택한 인터페이스 언어를 따릅니다.
- [fleet-console] wiki daemon health endpoint는 이제 하드코딩된 placeholder 대신 실제 패키지 버전을 보고합니다.
- [core-unified-agent] 제어 문자가 포함된 system prompt는 이제 Codex TOML profile로 직렬화될 때 완전히 escape됩니다.

### Removed
- [fleet-carriers] 모든 워크스페이스 패키지 전반의 dead code와 사용되지 않는 public API surface를 제거했습니다. CLI, MCP tool, 캐리어 또는 stored-configuration 계약은 변경되지 않았습니다.

## [1.3.1] - 2026-06-07

### Fixed
- [fleet-cli][fleet-console] 이름이 변경된 내부 core packages가 published bundle에서 누락되어 전역 설치된 `fleet` 명령이 module-not-found 오류와 함께 실행에 실패하던 문제를 수정했습니다.

## [1.3.0] - 2026-06-07

### Added
- [fleet-admiral] Fleet 세션에 이제 planning이 진행되기 전에 의사결정 형태의 planning 공백을 해결하기 위한 보조 Context Confidence 경로가 포함됩니다.
- [core-agent] 전용 Agent CLI 세션은 이제 working directory의 `.fleet/` 폴더에 있는 프로젝트 로컬 Fleet Project 플러그인을 렌더링하여, 해당 폴더가 있을 때 built-in Fleet 플러그인과 함께 hooks, skills, agents, MCP servers를 활성화합니다.
- [core-agent] 전용 Agent CLI 세션은 이제 홈 `~/.fleet/` 폴더에 있는 사용자 전역 Fleet Global 플러그인을 렌더링하여, 해당 폴더에 항목이 하나라도 있을 때 모든 프로젝트 전반에서 hooks, skills, agents, MCP servers를 활성화합니다.
- [core-agent] 이제 프로젝트 로컬 및 사용자 전역 Fleet 플러그인은 skills, agents, hooks, `.mcp.json`을 deep-copy 대신 symlink로 노출하므로, `.fleet/` 또는 `~/.fleet/`의 변경 사항이 세션 시작을 늦추지 않고 즉시 반영되며, 끊어진 link는 건너뜁니다.
- [fleet-admiral] 전용 Agent CLI 세션은 이제 built-in protocol-mode skills를 제공하며 Admiral prompt는 작은 protocol gate를 통해 모드를 선택합니다.
- [fleet-admiral] 이제 각 protocol-mode skill은 workflow가 시작되기 전에 해당 mode의 전제 조건을 확인하는 readiness checklist로 시작하며, 가벼운 단일 surface 검사부터 multi-carrier ownership 및 dependency staging까지 mode별로 규모가 조정됩니다.
- [fleet-admiral] 이제 각 protocol-mode skill은 계획, readiness checks, briefing, 실행 시작의 보고 주기를 따르므로 운영자는 Admiral이 각 mode를 실행하는 방식을 따라갈 수 있습니다.

### Changed
- [fleet-cli] 프로젝트 로컬 Fleet Project 플러그인은 이제 중첩된 `marketplace/` 디렉터리 대신 `CWD/.fleet/plugin/` 바로 아래에 렌더링되며, 프로젝트 및 전역 플러그인 asset은 모두 deep copy가 아닌 symlink로 노출됩니다. built-in Fleet 및 사용자 전역 Fleet Global 플러그인은 home marketplace에 그대로 유지됩니다.
- [fleet-cli] `fleet update`는 이제 단일 일반 메시지 대신 상황별 안내를 출력합니다. 로컬 development build에는 업데이트할 항목이 없음을 알리고, 최신 버전 설치는 이미 최신 버전이라는 알림과 함께 재설치를 건너뛰며, 감지할 수 없는 전역 설치, 쓰기 불가능한 설치 위치, 연결할 수 없는 registry check에는 각각 수동 fallback 지침 전에 별도 메시지가 표시됩니다.
- [fleet-cli] 범용 agent execution을 core-agent로 추출하고 unified-agent 및 MCP server 워크스페이스의 이름을 core packages로 변경했으며 core-to-Fleet dependency boundaries를 강제했습니다.
- [fleet-wiki] 전용 Agent CLI 세션은 이제 캐리어 및 wiki tool ID를 유지하면서 fleet이라는 단일 Fleet MCP server를 사용합니다.
- [fleet-wiki] 전용 Agent CLI 실행은 이제 provider별 marketplace metadata와 공식 Codex CLI plugin registration을 갖춘 공유 생성 marketplace 디렉터리를 통해 Fleet을 활성화하며, 캐리어 및 wiki MCP servers는 plugin bundle 대신 세션 시작 시 직접 주입된 상태로 유지됩니다.
- [fleet-cli] 전용 Agent CLI 세션을 위한 Fleet system prompt 주입은 이제 세션 plugin hooks 대신 temporary prompt files와 전용 Codex profile을 통해 CLI 실행 시점에 발생하며, 세션 플러그인은 계속 skills 및 subagent definitions를 렌더링합니다.
- [fleet-admiral] Claude-family 전용 세션은 이제 static Admiral system prompt에서 subagent guidance를 제외한 채 Fleet SessionStart hook을 통해 실시간 native-subagent guidance를 주입합니다.
- [fleet-carriers] Job Bar 캐리어 이름과 Task Force backend 행은 이제 각 dispatch에 실제로 사용된 model 및 effort를 표시합니다.
- [fleet-cli] Fleet Codex 플러그인은 이제 세션별 Codex profile을 통해 Fleet이 실행한 Codex 세션 내에서만 활성화되고 전역 Codex configuration에서는 비활성 상태로 유지되어 일반 Codex 세션에는 더 이상 영향을 주지 않습니다. 이전 marketplace names에서 남은 Fleet plugin 항목은 등록 중 비활성화됩니다.
- [fleet-cli] 생성된 세션별 Codex profile은 이제 Fleet system prompt를 단일 escape 줄 대신 실제 줄바꿈이 있는 multi-line TOML string으로 저장하여 profile을 사람이 읽을 수 있게 합니다.

### Fixed
- [fleet-cli][fleet-console] Windows에서 `fleet update`가 자동 전역 npm 또는 pnpm 업데이트를 실행하는 대신 수동 설치 지침만 출력하던 문제를 수정했습니다. 이제 Windows에서 package manager shim을 올바르게 resolve하고 호출하며, 수동 지침은 감지 또는 설치에 실패할 때만 표시됩니다.

### Removed
- [fleet-admiral] Admiral system prompt는 더 이상 tool별 guide block을 인라인으로 포함하지 않으며, tool별 guidance는 Fleet MCP tool metadata를 통해 계속 제공됩니다.
- [fleet-cli] 전용 Agent CLI 세션에서 Codex role-file 생성과 직접 prompt 및 inline agent 주입을 제거했습니다.
- [fleet-wiki] 이제 wiki-usage skill만 제공하는 Fleet plugin bundle에서 fleet-usage skill을 제거했습니다.

### Fixed
- [fleet-carriers][core-unified-agent] Codex 캐리어 ACP child process는 이제 Fleet CLI가 POSIX에서 종료될 때 terminal-close 및 fatal-error 종료를 포함해 안정적으로 종료되므로 더 이상 orphaned process로 남지 않습니다.
- [fleet-cli] Windows의 Claude-family 전용 세션은 더 이상 SessionStart hook module-loading 오류로 실행에 실패하지 않습니다. Fleet native-subagent hook은 이제 shell-independent invocation을 통해 실행됩니다.
- [fleet-cli] Windows의 Codex 전용 세션은 이제 Fleet plugin activation을 조용히 건너뛰는 대신 올바르게 등록하고 활성화합니다.

## [1.2.0] - 2026-06-03

### Added
- [fleet-cli] Job Bar backend 행은 이제 사용 가능한 경우 실제 backend 시작 및 종료 타임스탬프를 사용하여 backend별 경과 실행 시간을 인라인으로 표시합니다.

### Changed
- [fleet-cli] Mission Control은 이제 자동 전역 옵션 지속성을 갖춘 평면적인 LAUNCH/OPTION/SYSTEM 루트를 사용합니다.
- [fleet-cli] Mission Control은 이제 legacy `presets.json`을 무시하며, 운영자는 전역 옵션 도입 후 오래된 preset 파일을 수동으로 삭제할 수 있습니다.
- [fleet-cli] 공유 block-level layout primitives를 사용해 모든 Mission Control 패널에서 메뉴 및 정보 행 정렬을 통일했습니다. 이제 key:value 행은 각 그룹 안에서 콜론 기준으로 정렬됩니다.
- [fleet-cli] Job Bar token estimate는 이제 최종 값으로 점프하는 대신 매끄러운 frame-by-frame count-up 애니메이션을 적용합니다.
- [fleet-carriers] Job Bar 캐리어 strip tile은 더 이상 backend별 progress indicator를 렌더링하지 않으며, 활동은 작업 수준 status icon만으로 전달됩니다.
- [fleet-cli] Job Bar의 active-job indicator는 이제 `●`와 `○`를 번갈아 표시하는 대신 채워진 `●`를 켰다 껐다 하며 깜박입니다.

### Breaking Changes
- [fleet-cli] 전역 옵션을 위해 Fleet preset storage와 preset public API가 제거되었습니다.

## [1.1.3] - 2026-06-03

Release v1.1.3

## [1.1.2] - 2026-06-03

### Added
- [core-unified-agent] Cursor Agent provider가 이제 Claude Opus 4.8 (thinking) model을 지원합니다.
- [fleet-cli] Job Bar 작업 행은 이제 token estimate 왼쪽에 각 작업의 경과 실행 시간을 표시하며, 1분 미만에서는 초만, 그 이상에서는 분과 초를 표시합니다.

### Changed
- [fleet-carriers] Native(SubAgent) mode 캐리어는 이제 native CLI 경로에 더해 carrier_dispatch를 사용할 수 있지만, Task Force와는 계속 상호 배타적입니다.
- [fleet-carriers] Native(SubAgent) 캐리어용 Carrier Roster 및 Job Bar 행은 이제 [SA] badge를 유지하면서 전용 SA 색상 대신 각 CLI signature color로 렌더링됩니다.
- [fleet-cli] Job Bar token estimate는 이제 streamed text 및 tool label에 더해 tool result output 크기도 반영합니다.

### Removed
- [fleet-carriers] Job Bar 캐리어 strip tile에서 캐리어별 활성 작업 및 track count badge([N:M])를 제거했습니다. 실시간 활동은 여전히 breathing carrier icon으로 전달되며 [TF:N] 및 [SA] badge는 유지됩니다.

### Fixed
- [fleet-carriers] Carrier Roster 및 다른 Mission Control 패널은 이제 terminal 높이가 줄어들어도 focused item을 계속 표시합니다. 잘릴 수 있는 선택된 행은 자동으로 스크롤되어 보이게 됩니다.

## [1.1.1] - 2026-06-02

### Changed
- [fleet-cli] Mission Control은 이제 루트 및 중첩 패널 전반에서 도메인 단축키를 전혀 사용하지 않는 launcher-root 및 action-list 탐색 모델을 사용합니다.
- [fleet-cli] Fleet 그라데이션 배너가 이제 비활성 화면에서 오른쪽에서 왼쪽으로 흐르는 shimmer 애니메이션을 표시합니다.
- [fleet-cli] 비활성 Mission Control UI는 콘텐츠가 할당된 행보다 짧을 때 수직 중앙 정렬되며, 활성 Agent CLI PTY 출력은 상단 정렬을 유지합니다.
- [fleet-cli] Mission Control 패널이 이제 프레임 유틸리티, 강조 마커 및 선택 행 하이라이트를 사용해 일관된 시각적 처리를 공유합니다.
- [fleet-cli] 조건부 작업은 사용할 수 없을 때 비활성 행으로 표시되지 않고 메뉴에서 제외됩니다.
- [fleet-infra][fleet-carriers][fleet-cli] 원자적 쓰기, quarantine 기반 stale 복구를 포함한 advisory 디렉터리 잠금, 보안 파일시스템 가드를 통합하는 단일 영속 I/O 프리미티브(`fs-store`)를 `fleet-infra`에 도입했습니다. 이제 preset, auth 및 carriers 저장소는 독립 구현을 유지하는 대신 이 프리미티브를 사용합니다.
- [fleet-cli] 이제 Auth 저장소는 원자적 쓰기, 디렉터리 잠금 및 0600 파일 권한으로 보호되어 preset 저장소와 동일한 보안 수준을 충족하고 이전의 민감도 역전을 해결합니다.
- [fleet-cli] Auth 서비스가 순수 DI 팩터리(`createAuthService({ authPath })`)로 전환되었습니다. 모듈 수준의 가변 singleton 및 `setAuthPath`가 제거되었습니다.
- [fleet-cli] 이제 Auth 서비스는 Composition Root를 통해 연결되며, 모든 auth command 경로는 호출마다 생성하는 대신 주입된 `AuthService`를 받습니다.
- [fleet-cli] 민감한 데이터에 대해 실수로 0644로 생성되는 것을 방지하기 위해 이제 `fs-store`의 `sensitivity` 필드는 `CreateDurableJsonStoreDeps`에서 필수입니다.
- [fleet-carriers] 민감하지 않은 상태를 반영하고 민감도 모델에 맞추기 위해 `carriers.json` 쓰기 모드를 명시적으로 0644로 설정했습니다.

### Fixed
- [fleet-cli] 터미널 크기를 조정하거나 분할할 때 host TUI가 화면에 stale 문자와 행을 남기던 문제를 수정했습니다.

### Removed
- [fleet-infra] `@dotobokuri/fleet-infra/log` public subpath, runtime log store, carrier debug-log hooks, executor stderr log attachment 및 Mission Control log viewer를 제거했습니다.

## [1.1.0] - 2026-06-01

### Added
- [fleet-carriers] 이제 job-bar strip은 Native(SubAgent) 모드의 캐리어에 `[SA]` 배지를 표시합니다.
- [fleet-cli] Claude 계열 native subagent 세션을 위해 `claude-kimi` 전용 Agent CLI 프로필을 복원했습니다.
- [fleet-carriers] Claude 계열 전용 CLI 세션에 캐리어별 Native(SubAgent) 토글을 추가했습니다.
- [fleet-carriers] 시작 agent payload에 캐리어별 Claude Native(SubAgent) effort 기본값을 추가했습니다.
- [fleet-carriers] carrier_dispatch가 이제 native subagent 모드의 캐리어를 거부하고, 대신 host AI가 해당 CLI의 native subagent 경로를 통해 캐리어를 호출하도록 지시하는 accepted:false 응답을 반환합니다.
- [fleet-carriers] 이제 Codex 전용 CLI host는 Native(SubAgent) 모드를 지원하며, 토글된 캐리어를 자체 model 및 reasoning effort를 갖춘 native Codex subagent로 실행합니다.

### Changed
- [fleet-carriers] TaskForce 캐리어 job-bar 레이블, strip tile 및 헤더가 이제 backend별 행 색상은 유지하면서 시그니처 TaskForce blue로 렌더링됩니다.
- [fleet-carriers] 이제 Native(SubAgent) 모드 활성화와 TaskForce config 커밋은 상호 배타적이며, 하나가 다른 하나를 덮어쓸 경우 경고가 표시됩니다.
- [fleet-carriers] 이제 Carrier Status는 Mission Control의 `C` 단축키를 통해 Carrier Roster로 접근합니다.
- [fleet-carriers] 결정론적인 캐리어 등록 순서를 유지하면서 기본 캐리어 persona 설정을 각 persona module로 옮겼습니다.
- [fleet-cli] inline startup payload를 통해 주입되는 Claude 계열 Agent CLI native subagent는 이제 기본적으로 `background: true`를 사용하며 background task로 실행됩니다.

### Fixed
- [fleet-cli] 기존 Fleet scroll fallback 동작을 유지하면서 Agent CLI app-mouse drag 전달을 활성화했습니다.

### Removed
- [fleet-carriers] 캐리어 configuration을 여는 `Alt+O` host 단축키를 제거했습니다.
- [fleet-carriers] legacy 기본 persona registry export 및 사용되지 않는 carrier config renderer hook을 제거했습니다.
- [fleet-cli] upper-pane 선택에서 `claude-zai` 전용 Agent CLI 프로필을 제거했습니다. 기반 auth 및 provider backend는 계속 지원됩니다.
- [fleet-infra] 사용되지 않는 `@dotobokuri/fleet-infra/settings` package subpath와 더불어 더 이상 사용되지 않는 settings.json persistence 및 인접한 log-injection 코드를 제거했습니다.

## [1.0.2] - 2026-05-26

### Added
- [core-unified-agent] Cursor Composer 2.5 및 Composer 2.5 Fast 모델을 추가했습니다.

### Changed
- [fleet-cli][fleet-console] 릴리스 파이프라인을 `main` 브랜치로 통합했습니다. 이제 안정 릴리스는 `main`에 대한 push로 트리거되는 단일 워크플로에서 자동 버전 범프, CHANGELOG 승격, npm publish 및 GitHub Release 생성을 실행합니다.
- [fleet-cli][fleet-console] 이제 Mission Control welcome readout은 게시된 빌드를 일관되게 `stable`로 레이블링하며, 게시되지 않은 working copy는 `local`로 레이블링됩니다.
- [fleet-console] `fleet wiki --help`를 Fleet 브랜드의 영어 help 스타일 및 기본 `fleet wiki` command 표기와 일치시켰습니다.

### Removed
- [fleet-cli][fleet-console] `canary` npm dist-tag 및 `canary` 브랜치에 대한 모든 push에서 실행되던 auto-publish 워크플로를 제거했습니다. `canary` 브랜치는 PR 통합 대상로 유지되지만 더 이상 어떤 artifact도 게시하지 않습니다.
- [fleet-cli][fleet-console] `canary` 브랜치를 대상으로 하던 수동 workflow_dispatch 릴리스 워크플로를 제거했습니다.
- [fleet-cli][fleet-console] Fleet CLI 릴리스 유형, update channel, mission-control welcome label 및 prerelease detection logic에서 `canary` runtime channel을 제거했습니다.

## [1.0.1] - 2026-05-25

### Fixed
- [fleet-cli] 게시 메타데이터에서 패키지를 runtime dependency로 포함하여 `@dotobokuri/fleet-cli`의 전역 설치가 `ERR_MODULE_NOT_FOUND: @xterm/headless`로 시작 시 실패하던 문제를 수정했습니다.

### Changed
- [fleet-cli] package README에서 `@dotobokuri/fleet-cli`를 전역 전용 CLI 도구로 문서화하고 명시적인 `npm`, `pnpm`, `yarn` 설치 command를 추가했으며, 게시된 `package.json`에 `preferGlobal` flag를 추가했습니다.

## [1.0.0] - 2026-05-25

Release v1.0.0

## [0.22.2] - 2026-05-25

### Added
- [core-agent] 종료 후 upper Agent CLI를 시작하거나 다시 시작하는 Mission Control을 추가했습니다.
- [core-agent] authentication, wiki server 제어, diagnostics 및 about information을 위한 native Mission Control Fleet Menu 패널을 추가했습니다.
- [fleet-cli] Mission Control option 편집 및 명시적인 저장/초기화 제어 기능을 갖춘 영속 Fleet CLI startup preset을 추가했습니다.
- [fleet-cli] fleet CLI 종료 전 Ctrl+C 두 번 누르기 확인을 추가했습니다.
- [fleet-cli][fleet-console] 이제 Mission Control은 사용자의 channel에서 최신 버전을 npm registry로 비동기 확인하고 welcome 화면에 update-available notice를 표시합니다.
- [fleet-cli][fleet-console] 전역 설치를 자동 감지하고 package manager를 판별하여 `fleet-cli`와 `fleet-wiki-ui`를 함께 업그레이드하는 `fleet update` subcommand를 추가했습니다. 설치 범위를 확인할 수 없을 때는 install command를 출력하는 것으로 폴백합니다.

### Changed
- [core-agent] 활성 Agent CLI input pass-through를 유지하면서 Carrier Status가 Mission Control 패널로 열리도록 변경했습니다.
- [fleet-cli] 이제 Mission Control idle 화면은 기본 CLI picker 대신 Fleet 브랜드 welcome을 렌더링합니다. 여기에는 gradient banner, amber accent, carrier/wiki/queue readout 및 `local`, `canary` 또는 `stable`로 태그된 version line이 포함됩니다(게시되지 않은 working copy는 package `private` flag로 감지되며, 게시된 prerelease는 version suffix로 감지됩니다).
- [fleet-cli] CLI launch/profile 용어를 Agent CLI로 변경했으며, `agent-cli` 경로와 `FLEET_AGENT_CLI` selector를 포함합니다.
- [fleet-admiral] HUD 레이블은 단일 불변 Fleet Action Protocol에 연결된 compile-time constant가 되었습니다. protocol switching abstraction 및 dynamic protocol state가 제거되었습니다.
- [core-agent] 이제 fleet CLI는 알 수 없는 subcommand 및 option을 조용히 무시하는 대신 stderr에 error message를 표시하고 status 1로 종료합니다.
- [fleet-admiral] Admiral prompt 및 Fleet tool policy를 새 `@dotobokuri/fleet-admiral` workspace package로 추출했습니다. 이제 fleet CLI는 정책 module을 트리 내에 소유하는 대신 package의 root barrel을 통해 typed dependency로 이를 사용합니다.
- [core-agent] `createExecutorSessionManager(deps)` 팩터리와 `Executor*` session type을 추가했습니다. 이전에 `createDedicatedMcpSession`으로 명명된 multi-runtime MCP session lifecycle helper는 이제 generic MCP server package가 소유합니다.
- [fleet-carriers] `fleet-carriers` 내부 module topology를 `personas/`, `store/`, `dispatch/`, `stream/`, `jobs/`로 통합했으며, 더 이상 사용되지 않는 `job/` 및 `events/` 디렉터리 분할을 제거했습니다.
- [fleet-cli] Mission Control welcome banner를 `fleet --help` ASCII banner와 통합하여 두 surface가 단일 Fleet wordmark를 공유하도록 했습니다.
- [fleet-wiki][fleet-console] Wiki Server 패널이 이제 기존의 정상 background daemon을 재사용하고, 모든 상태에서 Enter로 browser를 열며(시작 또는 다시 열기), 전용 `S` 단축키로 daemon 중지를 제공하고, 기본 port를 `fleet wiki` CLI와 일치시킵니다.

### Fixed
- [core-agent] executor pool busy session isolation, stale pooled client lookup 및 내부 MCP tool signature drift를 수정했습니다.
- [fleet-wiki][fleet-console] 이전 daemon이 lock을 보유할 때 Wiki Server 패널이 조용히 실패하고, 패널 재진입 시 실행 중인 daemon을 중지된 것으로 잘못 보고하며, daemon 종료 중 permission error를 삼키던 문제를 수정했습니다.

### Removed
- [fleet-carriers] 더 이상 workspace package에서 사용되지 않는 carrier runtime, TUI primitive 및 agent model helper API를 제거했습니다.
- [core-agent] carrier session persistence runtime을 제거했습니다. 이제 session 재사용은 JSONL custom entry 추적 없이 오직 in-memory executor client pool state로만 구동됩니다.
- [fleet-cli] 최상위 `-rsp` / `--replace-system-prompt` Fleet CLI flag를 제거했습니다. 이 option은 이제 Mission Control options drawer, `FLEET_REPLACE_SYSTEM_PROMPT` env var 또는 저장된 preset을 통해 토글됩니다.
- [fleet-cli] 최상위 `-n` / `--native` 및 `-em` / `--enable-metaphor` Fleet CLI flag를 제거했습니다. 두 option은 이제 Mission Control options drawer, `FLEET_NATIVE` / `FLEET_ENABLE_METAPHOR` env var 또는 저장된 preset을 통해 토글됩니다.

### Breaking Changes
- [core-agent] `@dotobokuri/fleet-tui/input` 및 `@dotobokuri/fleet-tui/pty`를 제거했습니다. primitive component contract는 이제 `@dotobokuri/fleet-tui/components`를 사용하고, layout resize contract는 `@dotobokuri/fleet-tui/layout`를 사용하며, xterm 기반 Agent CLI viewport는 fleet CLI controls가 소유합니다.
- [core-agent] 트리 내 Grand Fleet policy module(IPC framing, mission reporter, status source, tool specs, ACP prompt builders, runtime access 및 text sanitizer)과 해당 test를 제거했습니다. 이 코드는 이미 fleet CLI runtime에서 참조되지 않았습니다.

## [0.22.1] - 2026-05-24

Release v0.22.1

## [0.22.0] - 2026-05-24

Release v0.22.0

## [0.22.1] - 2026-05-24

Release v0.22.1

## [0.22.0] - 2026-05-24

### Added
- [fleet-infra] auth, data-dir, job, log 및 settings service를 위한 host-agnostic infrastructure package로 `@dotobokuri/fleet-infra`를 추가했습니다.
- [fleet-carriers] 캐리어별 builtin external MCP allowlist를 추가했습니다. Tempest는 이제 grep.app code search MCP를 노출합니다.
- [core-agent] 마이그레이션된 auth storage 및 Claude 계열 alternate backend 지원을 갖춘 auth login, list 및 logout command를 추가했습니다.
- [core-agent] 선택된 전용 CLI로 model 이름을 전달하는 `--model` option을 추가하고, `--help` 출력을 Fleet Agent 및 기반 CLI option category로 재구성했습니다.
- [fleet-console] 이제 command palette를 Cmd+K(또는 Ctrl+K) keyboard shortcut으로 토글할 수 있습니다.
- [fleet-console] 이제 command palette는 열려 있는 동안 page scroll을 잠그고 닫을 때 복원합니다.
- [fleet-console] 이제 keyboard focus는 command palette가 열려 있는 동안 그 안에 고정되며, 닫을 때 이전 focus를 복원합니다.
- [fleet-console] 이제 search result 위에 hover하면 활성 선택 항목이 동기화됩니다.
- [fleet-console] 이제 result title의 search match가 시각적으로 강조됩니다.
- [fleet-console] 이제 search result는 가독성을 위해 marker를 제거한 body match excerpt를 표시합니다.
- [fleet-console] 이제 command palette 결과는 recent 및 matched entry의 section header 아래에 그룹화됩니다.

### Changed
- [fleet-console] inline mermaid diagram이 intrinsic size와 overflow scroll로 렌더링되는 대신 미니어처 overview로 container에 맞춰 축소됩니다. lightbox는 full-size pan/zoom을 유지합니다.
- [fleet-console] command palette search result에서 raw relevance score를 제거했습니다.
- [fleet-carriers] Fleet 내부 MCP access를 격리된 token을 갖는 독립적인 `fleet-carriers` 및 `fleet-wiki` server로 분리했습니다.
- [fleet-carriers] auto-promoted Task Force job의 carrier_jobs full response가 이제 단일 full_result string 대신 CLI type으로 키가 지정된 backend별 result를 반환합니다.
- [fleet-carriers] 더 이상 사용되지 않는 compatibility facade를 제거하면서 carrier runtime, dispatch, jobs, store 및 Task Force 구현을 `@dotobokuri/fleet-carriers`로 마이그레이션을 완료했습니다.

### Fixed
- [core-agent] CJK IME preedit를 전용 CLI input cursor에 고정하고, opt out해야 하는 terminal을 위해 `--disable-cursor-sync`를 추가했습니다.

### Breaking Changes
- [core-agent][core-unified-agent][fleet-infra][fleet-admiral][fleet-carriers][fleet-wiki][fleet-console][fleet-cli] 독립형 Fleet Admiral 및 Fleet Admiralty workspace package를 제거했습니다. 이후 Fleet Agent가 통합된 single-fleet 및 Grand Fleet policy module을 소유했습니다.
- [fleet-infra] 더 이상 사용되지 않는 root infrastructure re-export를 제거했습니다. 소비자는 infrastructure API를 `@dotobokuri/fleet-infra`에서 import해야 합니다.
- [fleet-carriers] carrier_taskforce tool을 제거했습니다. 이제 carrier_dispatch는 구성된 Task Force를 가진 캐리어를 multi-backend execution으로 자동 승격합니다.
- [fleet-carriers][core-agent] sortie toggle 기능을 제거하여 개별 캐리어를 offline으로 토글하는 기능, carrier status overlay의 'd' keybinding, offline carrier state/persistence 및 관련된 모든 UI indicator(예: 흐리게 표시된 roster line, inactive HUD tile 및 footer hint)를 없앴습니다.
- [core-agent] Fleet-world tone overlay는 이제 기본적으로 비활성화됩니다. 이전 `--disable-metaphor` flag는 제거되었고 명시적인 `--enable-metaphor` opt-in으로 대체되었습니다.
- [core-unified-agent] Gemini CLI provider 지원을 제거했습니다. 사용자와 API consumer는 다른 지원되는 CLI backend로 마이그레이션해야 합니다.

## [0.21.0] - 2026-05-20

### Added
- [core-agent] Claude 전용 CLI를 실행할 때 시스템 프롬프트를 추가하는 대신 재정의하는 `--replace-system-prompt` (`-rsp`) CLI 플래그를 추가했습니다.
- [fleet-cli] fleet-agent 부트 등록을 통해 전용 CLI MCP 세션에 Fleet Wiki 도구를 추가했습니다.
- [fleet-admiral][fleet-cli] Claude 및 Codex용 Fleet Admiral 프롬프트, Fleet MCP 접근 및 native permission bypass 플래그의 전용 CLI 실행 주입을 추가했습니다.
- [fleet-wiki] 보류 중인 wiki patch를 승인 게이트에 따라 제자리에서 편집할 수 있도록 `wiki_patch_edit`를 추가했습니다.
- [fleet-cli] 동적 작업 상태 섹션, 활성 작업 전용 frame ticker 및 프로그램 방식 PTY 입력 bridge를 포함하여 이전 harness의 Job Bar 기능을 fleet-agent에 흡수했습니다.
- [fleet-wiki] 동시 수정 충돌을 방지하기 위해 content hash 및 버전 검사를 사용하는 승인 시점 stale-base guard를 구현했습니다.
- [fleet-wiki] 항목 업데이트 전반에서 완전한 provenance 히스토리를 보존하도록 `rawSourceRefs`의 자동 누적 및 중복 제거를 추가했습니다.
- [fleet-wiki] path traversal 및 symlink/case-alias 공격을 방지하기 위해 POSIX 대상 검증 및 `realpath` 기반 승인 lock을 적용했습니다.
- [fleet-wiki] batch 작업을 위한 개선된 업데이트 provenance 및 관련 항목 추적 기능으로 `wiki_compile_source`를 개선했습니다.
- [fleet-wiki] `prompts.ts`의 모든 도구 프롬프트, schema 및 guideline을 영어로 현지화했습니다.

### Fixed
- [fleet-carriers] 고유 run identifier를 적용하여 동일 캐리어의 동시 dispatch가 하나의 PanelRun을 공유하고 한 줄로 합쳐지던 문제를 해결했습니다.
- [fleet-wiki] 전체 `patch.md` 콘텐츠를 포함하도록 patch hash 계산을 통합하여 `summary` frontmatter 변경 사항이 `changed_fields`, `patch_hash`, `base_patch_hash`에 올바르게 반영되도록 했습니다.
- [fleet-wiki] 동시 `wiki_patch_edit`, `approve`, `reject` 작업 중 race condition을 방지하기 위해 `patch_id`별 in-process mutex 및 snapshot atomicity를 도입했습니다.
- [fleet-wiki] 교차 편집 중 일관된 stale-base 감지를 보장하기 위해 실제로 기록된 patch hash의 단일 소스(SSoT)로 `lastEditHash`를 통합했습니다.
- [fleet-console] 큰 Mermaid diagram이 더 이상 문서 container 너비에 의해 잘리지 않습니다.
- [fleet-cli] agent 세션이 열렸지만 사용자 prompt를 한 번도 받지 않은 경우 지속되는 JSONL 세션 파일이 기록되지 않도록 하여 세션 selector에 "(no messages)" 항목이 누적되는 문제를 제거했습니다.
- [fleet-cli] stale state 업데이트를 방지하도록 cross-session token guard를 적용해 세션 commit 무결성을 강화했습니다.
- [core-agent] ACP tool-call queue에 FIFO fatal error 처리를 구현하여 세션 engine 안정성을 개선했습니다.
- [fleet-cli] 바인딩된 ACP 세션 ID가 변경되거나 socket drop 후 client가 자동 재연결될 때 Grand Fleet가 이제 Admiralty에 다시 등록하므로, 세션 전환 및 재연결 시 stale 등록 상태를 방지합니다.
- [fleet-cli] state property 접근을 수정하여 status overlay test의 type-checking 문제를 해결했습니다.
- [core-agent] `runtime.shutdown()`에 명시적인 executor pool 연결 해제 wiring을 추가하여 resource leak을 수정했습니다.

### Changed
- [core-agent] 캐리어 strip은 항상 표시되는 반면 Job Bar 세부 정보는 이제 하나 이상의 캐리어 작업이 활성 상태일 때만 자동으로 표시되어, 이전 toggle shortcut 및 empty-state placeholder를 대체합니다.
- [fleet-carriers] Job Bar 확장 보기를 캐리어 header와 독립적인 dispatch 하위 줄을 갖춘 계층 구조로 재설계했습니다.
- [fleet-carriers] 동일 캐리어에서 `carrier_dispatch`의 병렬 실행을 활성화하여 동시 요청에 대한 "carrier busy" 거부를 없앴습니다.
- [fleet-carriers] `fleet-store`의 `squadronEnabled` 지속성 키를 폐기했습니다. 이제 이 필드는 런타임 초기화 중 무시됩니다.
- [fleet-console] Fleet Wiki Web은 이제 workspace 범위 URL로 여러 등록된 workspace를 열 수 있는 사용자별 단일 daemon으로 실행됩니다.
- [fleet-console] `fleet-wiki` CLI 진입점을 워크트리 인식 방식으로 만들었습니다. 이제 git 워크트리 내에서 실행할 경우 적절한 워크트리 로컬 distribution을 자동으로 감지하고 실행합니다.
- [fleet-console] 더 넓은 문서 가독성을 위해 Table of Contents를 고정 레일 카드로 옮겼습니다. 카드는 비어 있으면 숨겨지며 모바일에서는 콘텐츠 위로 올라갑니다.
- [fleet-console] zoom 컨트롤(25–400%), drag-to-pan, mouse-wheel/keyboard shortcut, 열 때 auto-fit 및 탐색을 보존하는 anchor-link guard가 포함된 대화형 Mermaid diagram lightbox를 추가했습니다.
- [fleet-cli] 이제 prompt template은 `/skill:{name}` 규칙에 맞춰 일관된 slash-command 명명과 기본 제공 명령과의 namespace 충돌 위험 제거를 위해 `/prompt:{name}` prefix로 호출됩니다.
- [fleet-admiral][core-agent] Fleet MCP server 및 tool registry 내부 구현을 리프 패키지(`@dotobokuri/core-mcp-server`)로 추출하고 1MiB body cap, 5m timeout 및 snapshot cleanup으로 강화하면서 fleet-admiral facade 호환성을 보존했습니다. 자세한 내용은 패키지의 `MIGRATION.md`를 참조하세요.
- [core-agent] 트랜잭션 무결성을 보장하도록 state transition 및 실행 중 origin token을 캡처하고 검증하도록 세션 및 executor engine을 개선했습니다.
- [fleet-cli] synthetic ID 대신 세션 identifier 및 generation의 in-flight guard를 활용하여 Grand Fleet 등록 안정성을 개선했습니다.
- [fleet-cli] 더 나은 관측성을 위해 명시적 status 추적을 포함하도록 Grand Fleet 등록 state 필드를 개선했습니다.

### Removed
- [fleet-cli] 사용되지 않는 legacy 패널 hint constant를 제거했습니다.
- [fleet-cli] status source에서 폐기된 `visibleRunIdByCli` payload와 status update에서 `_streams` parameter를 제거했습니다.
- [fleet-carriers] `[SQ]` 배지, `→SQ` filtering, `S` toggle 특수 처리 및 Sortie-Squadron 상호 배제 로직을 포함한 squadron 전용 UI 요소를 제거했습니다.
- [fleet-cli] 전용 CLI 지원에서 Gemini 및 Cursor Agent를 제거했습니다.
- [fleet-cli] 'metaphor' domain(worldview, Operation naming, directive refinement)과 'request_directive' tool을 제거했습니다.
- [fleet-console] backend backlink indexer 및 관련 API와 함께 Constellation(backlinks) 패널 및 Outgoing references를 제거했습니다.
- [core-agent] service status UI 및 refresh 로직을 제거했습니다.

## [0.20.0] - 2026-05-16

### Added
- [fleet-carriers] 기본 캐리어 persona catalog 및 self-registration 패키지로 `@dotobokuri/fleet-carriers`를 추가했습니다.
- [fleet-carriers] tool 중심 등록은 보존하면서 캐리어 metadata 기반 executor MCP tool scoping을 추가했습니다.
- [core-unified-agent] ACP를 통해 안정적인 effort/reasoning parameter 조합과 함께 Cursor provider catalog에 1M context model을 추가했습니다.

### Changed
- [fleet-carriers] 동일 캐리어에서 `carrier_dispatch`의 병렬 실행을 활성화하여 동시 요청에 대한 "carrier busy" 거부를 없앴습니다.
- [fleet-carriers] `fleet-store`의 `squadronEnabled` 지속성 키를 폐기했습니다. 이제 이 필드는 런타임 초기화 중 무시됩니다.
- [fleet-carriers] 이제 캐리어의 이전 작업 접근은 상속된 기본값 대신 명시적인 persona `carrier_jobs` tool 및 `<prior_jobs?>` request-block 선언을 요구합니다. `CarrierMetadata.commonRequestBlocks`는 제거되었습니다.
- [fleet-carriers] 더 나은 domain 격리를 위해 `PRIOR_JOBS_REQUEST_BLOCK` constant를 fleet-admiral에서 fleet-carriers/constants.ts로 옮겼습니다.
- [fleet-wiki] 다섯 가지 읽기 전용 wiki tool(`wiki_briefing`, `wiki_orient`, `wiki_query`, `wiki_read`, `wiki_resolve`)은 이제 전역으로 등록되어 기본적으로 모든 캐리어에서 wiki knowledge base를 사용할 수 있습니다.
- [fleet-cli] `canary`만 허용되는 유일한 PR base로 적용합니다. fork에서 생성된 것을 포함한 non-canary PR은 안내와 함께 자동으로 닫힙니다.
- [fleet-cli] `main`에 push할 때마다 `main`과 일치하도록 `canary`를 자동 fast-forward하여 릴리스 commit이 자동으로 전파됩니다.
- [fleet-cli] `fleet-dev` binary를 제거했습니다. 대신 CWD 라우팅 개발 실행에는 `pnpm dev`를 사용하세요.
- [fleet-wiki] 이제 Wiki tool 렌더링은 캐리어 tool과 일관되며, 향상된 시각적 통합을 위해 TUI에서 투명 배경을 사용합니다.

### Fixed
- [fleet-wiki] 캐리어 executor MCP tool whitelist를 wiki module load order에서 분리했습니다. domain 패키지가 executor whitelist에 tool을 자체 등록하므로, fleet-wiki를 import하지 않고 호출해도 이제 fleet-admiral이 throw하지 않습니다.
- [fleet-cli] pr-creates skill의 로딩을 방해하던 누락된 frontmatter를 수정했습니다.

### Removed
- [fleet-carriers] `[SQ]` 배지, `→SQ` filtering, `S` toggle 특수 처리 및 Sortie-Squadron 상호 배제 로직을 포함한 squadron 전용 UI 요소를 제거했습니다.
- [fleet-cli] model cycling 범위 사용자 지정을 위한 관련 keybinding(`Ctrl+S`, `Ctrl+A`, `Ctrl+X`, `Alt+Up/Down`)과 함께 `/scoped-models` slash command 및 관련 configuration UI를 제거했습니다.

## [0.19.0] - 2026-05-13

Release v0.19.0

## [0.18.5] - 2026-05-12

### Fixed
- [fleet-console] prebuilt binary 또는 C++ toolchain이 없는 플랫폼(예: Windows arm64 + Node 25)에서 `pnpm install` 실패를 방지하도록 사용되지 않는 `canvas` devDependency를 제거하고 해당 `allowBuilds` 항목을 삭제했습니다.

## [0.18.4] - 2026-05-12

### Fixed
- [core-unified-agent] 이제 Codex legacy app-server 종료는 graceful, intentional 또는 abnormal로 분류되므로 false turn-completion crash는 억제되고 실제 child 종료에는 diagnostics가 포함됩니다.

## [0.18.3] - 2026-05-12

Release v0.18.3

## [0.18.2] - 2026-05-12

### Added
- [core-unified-agent] validation toggle(`CODEX_USE_ACP`)을 갖춘 Codex용 dual-transport 지원을 추가하여 새 npx bridge(`codex-acp`)와 legacy app-server connection을 모두 활성화했습니다.

### Changed
- [fleet-carriers] 동일 캐리어에서 `carrier_dispatch`의 병렬 실행을 활성화하여 동시 요청에 대한 "carrier busy" 거부를 없앴습니다.
- [fleet-carriers] `fleet-store`의 `squadronEnabled` 지속성 키를 폐기했습니다. 이제 이 필드는 런타임 초기화 중 무시됩니다.
- [core-unified-agent] ACP npx bridge route의 Windows 호환성 수정이 완료될 때까지 기본 Codex transport를 legacy app-server path로 되돌렸습니다.
