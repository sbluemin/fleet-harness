# Console Agent SDK

Console feature(Scuttlebutt 등)는 `features/execution/shared/agent.ts`의 서버 계약과, Console 조합이 그 feature의 deps로 주입한 `AgentHost` 포트(`deps.agent`)를 사용한다. 실행 엔진·Gateway URL·MCP 서버·자식의 작업 디렉터리를 직접 구성하지 않는다. 화면상의 Agent Operation이나 PTY를 만드는 API가 아니다.

```ts
import type { AgentEvent } from "../../execution/shared/agent.js";

const session = await deps.agent.createSession({
  model: "sonnet[1m]",
  effort: "low",
  systemPrompt: "Answer using only the supplied draft tools.",
  continuation: "oneshot",
  settlement: "result-required",
  timeoutMs: 600_000,
  tools: {
    builtins: [],
    custom: [{
      name: "draft",
      tools: [{
        name: "read",
        description: "Read this session's draft",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_args, { signal }) => {
          signal?.throwIfAborted();
          return { content: [{ type: "text", text: await draft.read() }] };
        },
      }],
    }],
  },
  onEvent(event: AgentEvent) {
    // 서버 내부 이벤트다. 제품별 브라우저 DTO는 따로 정제한다.
  },
});

await session.send("Review the draft.");
session.cancel();
await session.dispose();
```

## 계약

- `conversation`은 SDK 자식 세션을 이어간다. `oneshot`은 매 턴 독립 실행하며 이전 대화가 필요하면 제품이 프롬프트를 구성한다. provider 세션 ID는 노출하지 않는다. 이 포트로 연 세션은 모두 비영속이며, 새로 열면 새 대화다. 디스크에 남은 자식 이력으로 재개하는 API는 없다.
- `send`는 세션별 직렬 실행이다. `cancel`은 현재 턴만 중단하고 다음 턴은 허용한다. `dispose`는 영구 종료이며 신규 실행을 거절하고 자원 정리를 기다린다.
- `settlement: result`는 기존 실행 엔진의 결과 처리 의미를 유지한다. `result-required`는 결과 없는 종료를 `incomplete`로 보고하며 `timeoutMs`가 지정되면 watchdog을 사용한다.
- SDK가 내장 도구를 명시적으로 제한한다. 이 포트로 연 세션이 요청할 수 있는 내장 도구는 `WebSearch`, `WebFetch`, `SendMessage`, `ListAgents`, `Read`이며 생략하면 없다. `Read`는 요청한 세션에만 실리는 Agent SDK 내장 도구이며 경로를 제한하지 않는다. 셸·하위 Agent는 제공하지 않는다.
- `custom` 도구는 이 세션에만 연결된다. JSON Schema와 handler를 전달하며 provider SDK 핸들이나 MCP 인증 정보를 전달하지 않는다. handler는 취소 신호를 존중하고 쓰기 시 도메인의 stale-base·승인 방어를 유지해야 한다.
- `ConsoleUseMcpHost.contribute(tools)`(`features/console-use/shared/tools.ts`, Console 조합이 feature deps의 `consoleUse`로 주입)는 feature가 자기 영역의 화면을 `fleet-console-use` 서버에 싣는 길이다(예: Repository의 `console_repository`, File Explorer의 `console_explorer`, Objectives의 `console_objectives`·`console_objectives_detail`). 도구 하나가 화면 하나이고, 이름은 `console_<화면>[_<하위 화면>]`(`^console_[a-z]+(_[a-z]+)?$`)이다. 화면의 동사는 `features/console-use/shared/actions.ts`의 `defineConsoleTool`로 선언한 필수 `action` 필드로 고른다. action마다 strict zod 입력과 `kind`(`read`·`write`)를 두고, 필요하면 허용 호출자(`callers`)와 그 거부 코드(`refusal`)를 둔다. 도구 설명은 화면이 무엇인지 한두 문장(`MAX_TOOL_DESCRIPTION`, 200자)이고 action별 사실은 설명에 붙이지 않는다 — 파라미터의 사실은 그 필드의 `describe`(`MAX_FIELD_DESCRIPTION`, 120자)에, 거절의 뜻은 거절 응답의 `hint`에 둔다. 연결 공통 사실(수명·표시·대기)은 MCP server instructions에 한 번만 있다. 두 한도는 정의 단계에서 검사해 넘으면 등록이 실패한다. 기여는 `defineConsoleTool(...)`이 돌려준 도구의 `.plugin({ surface, execute })`로 만든다. 헬퍼로 만들지 않았거나 이름 규칙을 어기거나 호스트 기본 도구·다른 기여와 이름이 겹치면 등록이 실패한다. 광고하는 inputSchema는 최상위 object 하나(필수 `action` enum과 action 필드의 느슨한 합집합)이고, 설명 끝에 action 시그니처 한 줄이 붙는다. 호스트는 연결마다 action을 거른다: 읽기 전용 연결에는 `read` action만, 호출자 종류별로 허용된 action만 광고한다. 걸러진 action 호출은 그 거부 코드로 거절하고, 남은 호출은 action별 strict로 검증해 `execute`에 넘긴다. feature가 자기 세션에 직접 싣는 도구 묶음(사령관 같은)도 같은 필터(`{ caller, omit }`)를 `advertise`·`parse`·`plugin`에 쓴다. 기여한 도구는 모든 Console Use 연결(Operation 호출자·부관)에 실리며 호스트 기본 도구와 같은 게이트(Operation 토글 또는 부관 grant)를 지난다. feature는 자기 게이트를 따로 두지 않는다. 파일시스템·git 쓰기는 여기로 열지 않는다 — 그것은 그 Theater의 Operation에 시키는 일이다. feature **자기 제품 상태**의 쓰기(할 일 추가·완료 같은)는 `surface.describe`로 제스처(`create`·`press`·`input`)와 자리를 선언하고 저자 귀속·되돌리기를 갖출 때 허용된다. `execute`의 `context.caller`가 호출자(Operation 또는 feature)를 준다 — 계보·슬롯 권한은 그것으로 가른다.
- Admiral MCP 등록부(`features/execution/host/admiral-mcp.ts`의 `register(name, tools, registration)`, feature deps의 `registerMcp`로 주입)는 feature가 상수로 소유한 전체 서버 이름으로 서버를 연다(예: Codex의 `fleet-codex`, Objectives의 `fleet-objectives`). 이 이름은 세션의 도구 이름(`mcp__fleet-objectives__*`)이 되므로 바꾸지 않는다. 이 서버는 Console Use 토글과 무관하게 모든 Operation 세션에 실리고 화면 제스처가 없다 — 사람이 보는 Console 조작은 Console Use 기여 도구의 몫이다. 호스트는 세션 라벨로 푼 호출자 Operation을 `context.caller`로 넘기고, 풀리지 않으면 비워 둔다. 게이트가 없으므로 호출자에 따른 읽기·쓰기 권한은 도구가 `context.caller`로 스스로 가른다(Objectives: 읽기는 그 목표의 지휘관·담당만, 쓰기는 지휘관만). 도구가 닿는 곳이 사령관 하나의 지식뿐이면 `register(name, tools, { commodoreScoped: true })`로 등록한다(Codex). 그러면 호스트가 Operation 세션의 호출마다 세션 소속 사령관을 `context.commodoreId`로 싣고(풀리지 않으면 비움), 등록부의 `bindCommodore(commodoreId)`가 그 서버들을 서버 이름 그대로 `tools.custom` 그룹으로 내준다 — 묶은 도구는 `context.commodoreId`가 그 사령관으로, cwd가 그 사령관 디렉터리로 고정되고 호출자는 없다. 사령관 세션이 이 길로 자기 지식만 받는다. 사령관 지식의 root는 Console 조합이 Codex에 주입한 지식 포트의 `root(commodoreId)`가 정한다.
- `ConsoleControlHost`(`features/console-use/shared/control-port.ts`, Objectives deps의 `consoleControl`)는 `console_launcher`·`console_operation`의 `send`와 같은 서버 경로로 Operation을 시작하거나 그 입력창에 메시지를 넣고, `resume`으로 휴면 **터미널** Operation을 본문 없이 세션째 재개한다(살아 있는 터미널이면 `not_dormant`). 채팅은 자식 없이도 `live`이고 쉬는 상태는 `idle`이다. 다음 `send`가 같은 대화를 이어 가므로 sleep/resume은 각각 `chat_sleep_unsupported`/`chat_resume_unsupported`로 거절한다. `prepareChat`은 소유한 채팅의 SDK 주소를 명시적으로 준비해 SendMessage·ListAgents가 닿게 하며 모델 턴은 시작하지 않는다. `setCoordinates`는 자식이 없어도 검증한 모델·강도를 저장해 다음 기동에 적용한다. 호출자는 그 feature 자신이며 시트를 거치지 않는다. `OperationsHost.groups`(`features/execution/host/operations/ports.ts`)는 사이드바의 Operation 그룹을 feature 목록으로 연다. Operation의 그룹이 바뀌면(사람의 이동·Console Use·feature의 `patch({ groupId })`·그룹 삭제) 서버 안 채널 `operation:grouped`가 한 번 나므로, 그룹을 목록으로 쓰는 feature는 이것을 구독해 연결 항목을 따라 옮긴다. 같은 식으로 Operation·자식 세션의 `readOperationLaunch` 투영(세션 이름·채팅/터미널 표면·모델·effort·개시)이 실제로 바뀌면(채팅 화면의 모델 적용·채팅↔터미널 전환·재개) `operation:launch-changed`가 `{ operationId, parentOperationId }` 힌트만 싣고 한 번 난다 — 구독자는 `operations.get`으로 지금 값을 다시 읽는다.
- `consoleUse`는 Console 기본 도구(`CONSOLE_USE_TOOLS`: `console_context`·`console_sidebar`·`console_launcher`·`console_operation`)의 명시적 요청이며 `tools`를 생략하면 전부다. 읽기 전용은 도구 목록이 아니라 action 필터다. `allowControl: true`가 없으면 `read` action만 실리고 쓰기만 있는 `console_launcher`는 빠진다. `allowControl: true`를 요청하면 호스트가 feature 호출자를 바인딩하며, 실행은 Operation 토글 또는 부관 grant에 따른다. feature는 다른 호출자나 Operation을 가장할 수 없다. `enabled`는 호출마다 평가하고 `snapshot`은 보조 관측만 제공한다. 전역 Admiral 도구는 자동 연결하지 않는다.
- 실행 영수증과 자동 정책의 소유자는 Operation 또는 feature로 구분한다. 부관단은 feature 단위로 정책을 공유하므로 대화를 닫아도 유지되지만, 호스트 재시작 시에는 일시 중지되고 feature가 정리되면 더 실행하지 않는다.
- 임시 cwd·격리 SDK config·도구 연결은 Console 소유다. feature 조립 실패와 Console 종료 시에도 정리한다. 정상 종료를 거치지 않은 프로세스의 디스크 잔재는 세션 재개 권한이 아니다.
- `text`, `thinking`, `tool-start`, `tool-end`, `result`, `cancelled`, `compacted`, `compact-failed`, `input-started`, `input-cancelled`는 서버 이벤트다. 사용량은 공급자가 보고한 경우에만 포함한다. `usage.inputTokens`는 턴의 호출 합이고, 대화 크기는 마지막 호출의 입력인 `usage.contextTokens`다. 브라우저에 원시 도구 입력·오류·파일 경로를 그대로 전달하지 않는다. 모르는 이벤트 종류는 무시한다.
- `conversation` 세션은 문맥이 차면 같은 세션 안에서 대화를 요약해 이어 가고 그때 `compacted`(압축 전후 토큰)를 낸다. 요약에 실패하면 `compact-failed`를 내고 대화는 줄지 않는다 — 창을 넘긴 세션이면 이어지는 턴이 오류로 끝나므로, 오래 가는 세션의 소유자는 그때 세션을 바꾼다. `compactAt`(토큰)은 그 지점을 정한다. 호스트가 실행기의 자동 압축 창으로 옮기며, 네이티브 Claude 모델에만 적용된다 — Gateway 모델(비-Claude)은 Gateway의 compact 정책을 따른다. 그런 세션에서 호스트는 `contextTokens`와 `compacted`의 토큰을 공급자의 실제 토큰으로 되돌리고, 같은 단위의 창과 실제 압축 지점을 `usage.context`로 싣는다(모르면 `null`). 생략하면 실행기의 기본 지점이다.
- 이 포트는 feature의 업무 권한이나 사용자의 최종 승인 규칙을 바꾸지 않는다.

## 사령관 보드 통합

사령관은 `features/commodore`, 보드는 `features/objectives`의 Console 기능이다. 둘은 `features/commodore/shared/contracts/`의 계약으로 연결하며, Console 조합이 직접 잇는다. Objectives는 사령관 세션·화면 구현을 가져오거나 직접 띄우지 않는다.

- 서버: Objectives feature가 반환한 `board` 어댑터(보드 도구·관측·목표 조회·언어)를 Console 조합(`core/host/bootstrap/server.ts`)이 `commodore.host.registerBoard(objectives.board)`로 등록하고, 반환된 해제 함수를 Objectives 정리 수명에 묶는다. 대기·운영 주체·정체·자기 쓰기 판정은 보드 어댑터가 소유한다. `commodore.host.commander(theaterId)`(Objectives deps의 `commodoreCommander`)는 사령관이 만드는 목표의 지휘관 좌표를 읽기만 한다. 보드 어댑터가 없으면 사령관은 실행하지 않고 기존 데이터를 유지한다. 브라우저 view의 `boardReady`는 실행 가능 여부, `active`는 실험·저장된 자율 운영·보드 준비가 모두 충족된 상태다. 활성 글리프·상태 문장은 `active`를 사용하고, 저장된 스위치 위치는 보드가 없을 때 비활성화해 구분한다.
- 클라이언트: Console 조합(`core/client/src/integration/feature-registry.ts`)이 `createCommodoreClient(objectivesCommodoreBoard)`로 보드 투영·구독·목표 열기·아바타 렌더러를 사령관에 넘기고, 사령관의 `CommodoreClientHost`(상태·구독·열기·언어·행 글리프)를 Objectives에 넘긴다. 공유 상태·기록·질문·기억 DTO는 `features/commodore/shared/contracts/`에 있다.
- 사령관 HTTP는 `/api/v1/commodore/*`, SSE 채널은 `commodore`다. 요청은 `commodoreId`(UUID)를 사용한다. Theater 머리에서는 `commodore/resolve { theaterId }`로 UUID를 얻고, `commodore/create { theaterId }`는 멱등 발급이다. SSE 사건은 `commodoreId`와 표시용 `theaterIds`를 싣는다. 보드 행위자의 `{ kind: "commodore", theaterId }`는 보드의 Theater 경계를 유지한다. 클라이언트 제공자 id는 `commodore`지만 저장된 대화 표면 id `commodore`는 그대로 유지한다.

## 소비자

- Scuttlebutt: 대화 연속성, 웹 도구, grant로 허용하는 Console 관측·실행·자동 운영과 Wiki 읽기. 페르소나·제품 세션·SSE 표현은 Scuttlebutt feature 소유.
- Console 사령관 기능: 등록 Theater마다 `<Console 데이터 루트>/commodore/<UUID>/`를 선제 발급한다. 이전 workspace의 cwd를 읽지 못하면 정준 Theater 경로의 digest·옛 이름 후보와 겹치는 Theater만 발급을 보류하고, 수리 후 다음 기동에서 기존 기록을 이동한다. 다른 Theater의 발급은 막지 않는다. `state.json`에는 `theaters: [{ path }]` 하나만 두고 경로는 정준 실경로다. UUID는 폴더 이름이고, Theater 해시는 기동 때 색인으로 다시 만든다. 잊힌 Theater의 폴더·연결은 지우지 않는다. 이 경로들은 서버 내부이며 브라우저 상태 투영에는 실리지 않는다.
- 사령관은 `AgentHost` 포트가 아니라 `features/execution`의 내부 비영속 상주 API를 쓴다. cwd는 사령관 폴더를 빌리고, CLI 홈·좌표는 세션별 OS 임시 `fleet-commodore-*` 아래에만 둔다. 폐기는 임시 폴더만 회수한다. 같은 살아 있는 세션의 자식 재시작은 자기 임시 이력만 이어받고, Console 재시작·자율 운영 재개·교대는 새 대화다. 첫 턴은 제품 `transcript.jsonl`의 최근 결과 12개와 보드 행위 수로 만든 요약을 받는다. Clear 뒤에는 요약이 없다. 턴 중 사람의 말과 전달 여부 사건은 내부 상주 경로로 유지한다.
