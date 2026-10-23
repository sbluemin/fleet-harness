import type { ConsoleActionInput, ConsoleActionResult, ConsoleCoordinates, ConsoleCoordinatesResult, ConsoleOperationObservation, ConsoleSessionMessage, ConsoleTranscriptPage, ConsoleTurnEnd } from "./control.js";
/**
 * Console Use 와 같은 제어 경로로 Operation 을 시작하거나 그 입력창에 메시지를 넣는 능력. 호출자는 이 플러그인
 * 자신이며(`{ kind: "plugin", pluginId }`), 시작한 Operation 의 `payload.launchedBy` 에 그렇게 남는다. 시트를 거치지
 * 않는다 — `console_launcher` 가 쓰는 서버 경로 그대로다. 없는 호스트에서는 없다.
 */
export interface ConsoleControlHost {
  /** 전달이 끝날 때까지(operationId 또는 실패) 기다린다. 실패는 코드 문자열을 message 로 던진다. 결과는 남지 않고, 같은 입력을 다시 보내면 다시 실행된다. */
  request(input: ConsoleActionInput): Promise<ConsoleActionResult>;
  /** 한 Operation 의 지금 관측 — 활동·생명주기·표면·마지막 산출. 모르면 null. */
  observe(operationId: string): ConsoleOperationObservation | null;
  /** 소유한 세션의 종료 snapshot. 다음 턴이 곧 시작해도 polling이 실패를 놓치지 않는다. */
  subscribeTurnEnds?(listener: (event: ConsoleTurnEnd) => void): () => void;
  /** 소유한 세션 사이에 닿은 세션 간 메시지 — 보낸·받은 Operation 과 시각만(본문 없음). 보낸 쪽이 채팅 세션일 때만 관측된다. */
  subscribeSessionMessages?(listener: (event: ConsoleSessionMessage) => void): () => void;
  /**
   * 유휴 터미널 Agent Operation을 휴면으로 보낸다. 채팅은 chat_sleep_unsupported, 진행 중이면 not_idle. `dormant` 는 옛 프로세스가 끝난 것까지 확인했다는 뜻이고,
   * `ending` 은 휴면으로 전이했지만 그 종료를 아직 확인하지 못했다는 뜻이다. 어느 쪽이든 곧바로 재개를 보내도 된다 — 호스트는 옛 프로세스가
   * 사라질 때까지 다음 기동을 미루고, 상한 안에 사라지지 않으면 operation_busy 로 거절해 휴면으로 남긴다.
   * `endPendingWork` 는 interrupt 로 풀 수 없는 두 상태도 재운다 — 사람의 답을 기다리는 터미널 세션은 떠 있던 질문·허가 요청을 버리고,
   * 백그라운드 작업이 남은 세션은 그 작업을 끝낸다. 사람이 그 작업의 종결을 결정한 경우에만 쓴다. 실행 중인 턴은 여전히 not_idle 이다.
   */
  sleep?(operationId: string, options?: { readonly endPendingWork?: boolean }): Promise<{ readonly ok: true; readonly lifecycle: "dormant" | "ending" } | { readonly ok: false; readonly error: string }>;
  /** 소유한 채팅의 SDK 주소를 명시적으로 준비한다. 모델 턴이나 lifecycle 전이는 없으며 실패는 코드로 던진다. */
  prepareChat?(operationId: string): Promise<void>;
  /** capture 전인 유휴 채팅의 프리셋. 자식이 없으면 저장 좌표만 바꾸고, 자식이 있으면 기존 소유 검사를 적용한다. */
  setUnstartedPreset?(operationId: string, input: { readonly model: string; readonly effort: string | null }): Promise<ConsoleCoordinatesResult>;
  /**
   * 이미 있는 Operation의 다음 프로세스 기동(휴면 재개·채팅을 새로 띄우는 실행)에 쓸 서브에이전트 정책.
   * live 프로세스는 중단하지 않고, 세션 스냅샷도 바꾸지 않는다. 없는 Operation은 무시한다.
   * `blocked`는 강제 차단, `default`는 그 차단을 걷고 전역 정책만 적용한다.
   */
  setSubagentSpawn?(operationId: string, policy: "blocked" | "default"): void;
  /**
   * @deprecated Console이 띄우는 Claude 세션은 사람에게 묻는 도구(`AskUserQuestion`)를 늘 빼므로 정할 정책이 없다.
   * 호스트는 이 메서드를 제공하지 않는다 — 옛 플러그인의 `?.()` 호출은 아무 일도 하지 않는다.
   */
  setUserQuestions?(operationId: string, policy: "blocked" | "default"): void;
  /**
   * Console이 띄운 Claude 세션의 서브에이전트(Agent 도구) 호출에 이 플러그인이 답한다. 호출마다 그 세션의 Operation id로
   * `reason` 을 부르고, 문자열을 돌려주면 서브에이전트를 띄우지 않고 그 문장을 도구의 거절 사유로 모델에게 전한다. null 이면
   * 이 플러그인은 관여하지 않는다. 판단이 던지면 호출은 막힌다. Workflow 도구의 agent()는 이 경로를 지나지 않는다.
   * 등록을 거두는 함수를 돌려준다. 없는 호스트에서는 없다.
   */
  redirectAgentCalls?(reason: (operationId: string) => string | null): () => void;
  /**
   * 떠 있는 채팅 세션의 모델·강도를 바꾼다 — 채팅 화면의 모델 메뉴와 같은 후보·같은 검증을 지난다. 턴이 도는 중이면 그 턴이 닫히는
   * 경계로 미루고(`scheduled`), 지금 실행값을 다시 고르면 예약을 거둔다. 이 플러그인이 띄운 Operation(또는 그 자식)만 받는다 —
   * 아니면 `forbidden`. `effort` 는 런치 어휘이며 null 은 모델 기본이다. 자식이 없으면 저장 좌표만 바꾸고 다음 기동에 적용한다. 터미널은 `chat_not_active` 다.
   */
  setCoordinates?(operationId: string, input: { readonly model: string; readonly effort: string | null }): Promise<ConsoleCoordinatesResult>;
  /** 떠 있는 채팅 세션의 지금 좌표와 예약. 떠 있는 채팅이 아니면 null. */
  coordinates?(operationId: string): ConsoleCoordinates | null;
  /**
   * 이 플러그인이 띄운 떠 있는 채팅 세션이 init 에서 모델에게 광고한 도구 이름. 아직 모르거나(미기동·init 전·터미널) 남의 세션이면 null —
   * null 은 「도구가 없다」가 아니다.
   */
  advertisedTools?(operationId: string): readonly string[] | null;
  /**
   * Agent Operation 의 전사 한 쪽 — Console Use `console_operation` 의 transcript 읽기와 같은 줄(사람의 말·답·도구·질문·턴 결말)이고
   * 본문은 자격증명 마스킹을 지난 신뢰할 수 없는 데이터다. 이 플러그인이 띄운 Operation(또는 그 자식)만 받는다 — 아니면 `forbidden`.
   * 커서 없이 `tail` 이면 마지막 `limit` 줄(그 앞이 남았으면 truncated)이고, 아니면 커서부터 앞으로 읽는다.
   */
  transcript?(operationId: string, input: { readonly cursor?: string; readonly limit: number; readonly tail?: boolean }, signal?: AbortSignal): Promise<ConsoleTranscriptPage | { readonly error: string }>;
  /**
   * 이 플러그인의 멱등 기동 키(`ConsoleActionInput.launchKey`) 상태 — absent(영속된 적 없음) · reserved(예약만) · pending(이 호스트에서
   * 기동 중) · live · deleting(삭제 유예) · purged. 다른 Theater 에 선 키는 `launch_key_conflict` 로 거절하고 그 Operation 을
   * 드러내지 않는다. 원장을 읽을 수 없으면 `storage_unavailable` 을 던진다(absent 로 추측하지 않는다).
   */
  launchState?(input: { readonly theaterId: string; readonly key: string }): { readonly state: "absent" | "reserved" | "pending" | "live" | "deleting" | "purged"; readonly operationId?: string };
  /**
   * 키들을 한꺼번에 예약한다(전부 또는 전무) — 새 키만 용량을 쓰고, 넘치면 `launch_key_capacity`. 수락한 키는 만료하지 않으며
   * 그 키의 삭제 기록·조회·같은 키 재기동은 용량과 무관하다.
   */
  reserveLaunchKeys?(input: { readonly theaterId: string; readonly keys: readonly string[] }): void;
  /** 이 플러그인이 쓴 키 수와 상한. */
  launchKeyUsage?(): { readonly used: number; readonly limit: number };
}
