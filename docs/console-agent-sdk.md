# Console Agent SDK

Console 플러그인은 `@fleet-console/sdk/agent`의 서버 계약과 `ctx.host.agent`를 사용한다. 실행 엔진·Gateway URL·MCP 서버·자식의 작업 디렉터리를 직접 구성하지 않는다. 화면상의 Agent Operation이나 PTY를 만드는 API가 아니다.

```ts
import type { AgentEvent } from "@fleet-console/sdk/agent";

const session = await ctx.host.agent.createSession({
  model: "sonnet",
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

- `conversation`은 SDK 자식 세션을 이어간다. `oneshot`은 매 턴 독립 실행하며 이전 대화가 필요하면 제품이 프롬프트를 구성한다. provider 세션 ID는 노출하지 않는다.
- `send`는 세션별 직렬 실행이다. `cancel`은 현재 턴만 중단하고 다음 턴은 허용한다. `dispose`는 영구 종료이며 신규 실행을 거절하고 자원 정리를 기다린다.
- `settlement: result`는 기존 실행 엔진의 결과 처리 의미를 유지한다. `result-required`는 결과 없는 종료를 `incomplete`로 보고하며 `timeoutMs`가 지정되면 watchdog을 사용한다.
- SDK가 내장 도구를 명시적으로 제한한다. 플러그인 세션이 요청할 수 있는 내장 도구는 `WebSearch`, `WebFetch`이며 생략하면 없다. 파일·셸·하위 Agent는 기본 제공하지 않는다.
- `custom` 도구는 이 세션에만 연결된다. JSON Schema와 handler를 전달하며 provider SDK 핸들이나 MCP 인증 정보를 전달하지 않는다. handler는 취소 신호를 존중하고 쓰기 시 도메인의 stale-base·승인 방어를 유지해야 한다.
- `consoleUse`는 Console 기본 도구의 명시적 요청이다. `allowControl: true`와 제어 도구 목록을 요청하면 호스트가 플러그인 호출자를 바인딩하며, 실행은 콘솔 사용 옵트인에 따른다. 플러그인은 다른 호출자나 Operation을 가장할 수 없다. `enabled`는 호출마다 평가하고 `snapshot`은 보조 관측만 제공한다. 전역 Admiral 도구는 자동 연결하지 않는다.
- `aiGateway: true`는 fleet-ai-gateway 리소스 서버(라우팅 가이드·노출 모델 로스터)를 이 세션에 연결하고, 그 리소스를 읽을 내장 도구만 함께 연다. 도구·위임 실행 능력은 주지 않으며, 노출 로스터의 모델 표기는 `console_launch`가 그대로 받는다.
- 실행 영수증과 자동 정책의 소유자는 Operation 또는 플러그인으로 구분한다. 부관단은 플러그인 단위로 정책을 공유하므로 대화를 닫아도 유지되지만, 호스트 재시작 시에는 일시 중지되고 플러그인이 해제되면 더 실행하지 않는다.
- 임시 cwd·격리 SDK config·도구 연결은 Console 소유다. 플러그인 등록 실패와 Console 종료 시에도 정리한다. 정상 종료를 거치지 않은 프로세스의 디스크 잔재는 세션 재개 권한이 아니다.
- `text`, `thinking`, `tool-start`, `tool-end`, `result`, `cancelled`는 서버 이벤트다. 사용량은 공급자가 보고한 경우에만 포함한다. 브라우저에 원시 도구 입력·오류·파일 경로를 그대로 전달하지 않는다.
- 이 SDK는 same-process 플러그인을 샌드박싱하지 않는다. 플러그인의 업무 권한과 사용자의 최종 승인 규칙은 바뀌지 않는다.

## 소비자

- Scuttlebutt: 대화 연속성, 웹 도구, 옵트인 Console 관측·실행·자동 운영과 Wiki 읽기. 페르소나·제품 세션·SSE 표현은 플러그인 소유.
- Codex Cowork: 원샷 실행, 10분 watchdog, draft 3개와 Wiki 읽기 4개. draft 상태·주석·히스토리 구성·Apply 승인은 Codex 소유. scoped draft 도구는 전역 Admiral MCP에 등록하지 않는다.
