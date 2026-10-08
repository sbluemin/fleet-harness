export type ConsoleActivity = "idle" | "running" | "awaiting" | "background" | "ended" | "unknown";
export type ConsoleActionKind = "launch" | "send" | "interrupt" | "resume";
export type ConsoleCaller = { readonly kind: "operation"; readonly operationId: string } | { readonly kind: "plugin"; readonly pluginId: string };

export interface ConsoleActionInput {
  readonly kind: ConsoleActionKind;
  readonly theaterId?: string;
  readonly operationId?: string;
  /** launch 의 첫 프롬프트 / send 의 본문. launch 에서는 생략할 수 있다 — 그 세션은 첫 턴 없이 서서 메시지를 기다린다. */
  readonly text?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly viewMode?: "chat" | "terminal";
  /**
   * launch·send 전용 — 원장(채팅뷰 말풍선)에 세울 문면. 없으면 `text` 가 그대로 선다. 자식에게 가는 것은 언제나
   * `text` 다. 플러그인이 모델용 구조화 프롬프트와 사람용 요약을 갈라 보낼 때 쓴다. send 의 빈 문자열은 "보일 문면이
   * 없다"는 뜻이다 — 플러그인이 보낸 말은 출처 줄 하나로만 선다. `text` 안의 부분 문자열이면 세션을 다시 연 뒤에도
   * 같은 문면이 선다.
   */
  readonly display?: string;
  /** `display` 의 형식. markdown 이면 말풍선이 마크다운으로 그린다. 기본은 평문. */
  readonly displayFormat?: "markdown" | "text";
  /** launch 전용 — 태어날 때부터 속할 그룹과 이름. 같은 Theater 의 그룹이어야 한다. */
  readonly groupId?: string;
  readonly title?: string;
  /** launch 전용 — CLI 세션의 표시 이름. 세션 목록·터미널 제목에 서고, 다른 세션이 이 세션에 메시지를 보낼 주소가 된다. */
  readonly sessionName?: string;
  /** launch 전용 — 태어날 때 서브에이전트(Claude Code `Agent` 도구, fleet:execute 포함)를 모두 끈다. 이후 변경은 `setSubagentSpawn`이며 이미 뜬 프로세스는 다음 기동까지 그대로다. */
  readonly disableSubagents?: boolean;
  /** launch 전용 — 태어날 때 사람에게 묻는 도구(`AskUserQuestion`)를 뺀다. 이후 변경은 `setUserQuestions`이며 이미 뜬 터미널 프로세스는 다음 기동까지 그대로다. */
  readonly disableUserQuestions?: boolean;
  /** launch 전용 — Operation만 만들고 첫 send 때 새 세션으로 깨운다. */
  readonly dormant?: boolean;
  /**
   * launch 전용 — 태어날 때부터 이 Operation 아래 선다(목표의 구성원 → 지휘관). 같은 Theater 의, 부모가 없는 Operation 이어야 한다.
   * 태어난 뒤에 붙이면 첫 방송에 부모 없는 행이 실려 목록에 한 번 선다 — 그래서 기록은 생성과 함께다.
   */
  readonly parentOperationId?: string;
  /** 플러그인 전용 자식 UUID. 같은 부모와 같은 id는 기존 세션을 돌려준다. */
  readonly childSessionId?: string;
  /**
   * launch 전용·플러그인 호출자 전용 — 멱등 기동 키(`[A-Za-z0-9._:-]{1,128}`, 호출 플러그인 범위). 같은 키로는 Operation 이 많아야
   * 하나 생긴다: 살아 있으면 그 Operation 을 돌려주고, 삭제됐으면(유예 중·purge) `launch_key_deleted` 로 거절한다. 키는 생성과
   * 함께 영속되며 만료하지 않는다. 새 키는 소유자별 용량 안에서만 받는다(`launch_key_capacity`).
   */
  readonly launchKey?: string;
  /** 플러그인의 키 붙은 새 기동에서만 지정할 수 있는 Operation UUID. */
  readonly newOperationId?: string;
}

/** 턴 실패의 원문 데이터 — 문자열을 요약하거나 지시로 실행하지 않는다. */
export interface ConsoleTurnFailure {
  readonly error: string;
  readonly error_details?: string;
  readonly last_assistant_message?: string;
}

/**
 * 닫힌 턴이 세션 밖으로 남긴 것. 관측하는 표면(채팅)만 싣는다 — 없으면 "모른다"이고, 빈 `sentTo` 와 다르다.
 * 성공으로 닫힌 턴이 아무에게도 말을 남기지 못했는지를 실패 결말 없이 가를 수 있게 한다.
 */
export interface ConsoleTurnReport {
  /** 이 턴의 최상위 SendMessage 중 결과까지 성공한 호출의 받는 이름. 거절·오류로 끝난 호출과 서브에이전트의 호출은 없다. */
  readonly sentTo: readonly string[];
  /** 사람이 입력창에서 보낸 말로 열린 턴이다. 플러그인·다른 Operation 이 보낸 말과 자식이 스스로 연 턴은 false. */
  readonly byPerson: boolean;
  /** SDK result 가 말한 최종 응답 원문. `output.text` 의 꼬리 자르기·정리를 지나지 않는다. 성공한 턴에만 있다. */
  readonly answer?: string;
  /**
   * 턴이 닫힐 때 이 세션을 다시 깨울 일이 남았다 — 살아 있는 백그라운드 작업(셸·모니터·서브에이전트 등)이 있거나, 이 턴에서
   * 깨움 예약(`ScheduleWakeup`·`CronCreate`)이 성공했다. 외부 대기를 걸고 닫은 턴은 멈춘 턴이 아니다.
   */
  readonly pendingWork: boolean;
}

/** 다음 턴이 관측을 덮기 전에 전달하는 종료 snapshot. 브라우저 알림 채널이 아니다. */
export interface ConsoleTurnEnd {
  readonly operationId: string;
  readonly generation?: string;
  readonly output: ConsoleOperationObservation["output"];
}

export interface ConsoleOperationObservation {
  readonly activity: ConsoleActivity;
  readonly lifecycle: "live" | "dormant" | "unknown";
  /**
   * live 동안만 — 지금 생산자(PTY·채팅 SDK 세션)의 불투명 세대. 세션 좌표를 읽고 선 프로세스마다 새 값이고 Console 을 다시 띄워도
   * 겹치지 않는다. 같은 값이면 같은 프로세스다 — 휴면을 거쳐 다시 깨어났는지를 관측 한 번으로 가른다.
   */
  readonly generation?: string;
  readonly observedAt: string;
  readonly source: "host";
  readonly attention: { readonly kind: "none" | "input" | "permission" | "failure" | "unknown" };
  readonly surface: "chat" | "terminal";
  readonly supportedActions: readonly ConsoleActionKind[];
  readonly output: {
    readonly status: "available" | "unavailable";
    readonly source?: "terminal_hook" | "terminal_transcript";
    readonly text?: string;
    readonly truncated?: boolean;
    readonly revision?: number;
    readonly outcome: "unknown" | "running" | "completed" | "succeeded" | "failed" | "interrupted";
    readonly failure?: ConsoleTurnFailure;
    /** 닫힌 턴의 보고 — 관측하는 표면만 싣는다. */
    readonly report?: ConsoleTurnReport;
  };
}

/**
 * 한 동작의 결과 — 영속하지 않는다. 전달(메시지 입력·시작·중단·재개)이 끝나면 호출자에게 한 번 돌아가고 남지 않는다.
 * 턴의 종료가 아니다: 그 뒤의 활동·산출은 Operation 관측이 말한다. 이미 살아 있는 키 붙은 기동은 delivery 없이 그 Operation 을 돌려준다.
 */
export interface ConsoleActionResult {
  readonly operationId: string;
  readonly delivery?: "queued" | "confirmed" | "requested";
}

/**
 * 떠 있는 채팅 세션의 모델·강도 변경 결말. `now` 는 자식에 적용됐고, `scheduled` 는 도는 턴이 닫히는 경계에서 적용된다 —
 * 그 예약은 호스트 메모리에만 있고 세션 좌표(payload)는 적용될 때 고쳐진다. `unchanged` 는 이미 그 값이라 예약도 거뒀다는 뜻이다.
 * `chat_not_active` 는 떠 있는 채팅이 아니다(휴면·터미널·아직 세션 없음).
 */
export type ConsoleCoordinatesResult =
  | { readonly ok: true; readonly applied: "now" | "scheduled" | "unchanged" }
  | { readonly ok: false; readonly error: "unknown_operation" | "forbidden" | "chat_not_active" | "invalid_model" | "invalid_effort" | "context_exceeds_window" }
  | { readonly ok: false; readonly error: "coordinates_apply_failed"; readonly cause?: ConsoleCoordinatesFailureCause };

/**
 * 자식이 모델·강도 변경을 거절한 원 예외 — `coordinates_apply_failed` 의 사유다. 문자열을 자르거나 요약하거나 지시로 실행하지 않는다.
 * 예외가 아닌 값이 던져지면 `message` 는 그 값의 문자열이다. 원 예외가 없는 실패(적용 직전 문맥 초과 등)에는 없다.
 */
export interface ConsoleCoordinatesFailureCause {
  /** 원 예외의 문장. 자격 증명 모양(키·토큰)만 치환하고 나머지는 그대로다 — 공급자 본문이 비밀을 되울려도 문맥·전사·보드에 남지 않게. */
  readonly message: string;
  readonly name?: string;
  readonly code?: string;
  /** SDK 가 붙인 실패 분류(control_request_failed·process_exited_nonzero·spawn_failed·error_result 등). */
  readonly errorClass?: string;
  /** 자식 프로세스가 끝났을 때의 종료 코드와 신호. */
  readonly exitCode?: number;
  readonly signal?: string;
}

/** 떠 있는 채팅 세션의 지금 좌표와 턴 경계를 기다리는 예약. 예약은 적용이 끝나는 순간에야 비워진다. `effort` 는 런치 어휘다. */
/** Operation 전사의 한 쪽 — 사람의 말·답·도구·질문·턴 결말 줄. 본문은 마스킹을 지난 신뢰할 수 없는 데이터다. `nextCursor` 가 null 이면 끝까지 읽었거나 꼬리 읽기다. */
export interface ConsoleTranscriptPage {
  readonly source: "chat" | "terminal";
  readonly entries: readonly Record<string, unknown>[];
  readonly nextCursor: string | null;
  readonly truncated: boolean;
}

export interface ConsoleCoordinates {
  readonly model: string;
  readonly effort: string | null;
  readonly pending: { readonly model: string; readonly effort: string | null } | null;
  /**
   * 자식이 마지막으로 거절한 좌표와 그 원 예외 — 턴 경계에서 적용하다 거절된 예약도 사유가 남게 한다. 다음 적용이 성공하면 사라진다.
   * 거절된 적이 없으면 없다.
   */
  readonly refused?: { readonly model: string; readonly effort: string | null; readonly cause: ConsoleCoordinatesFailureCause };
}

export interface ConsoleAutomationInput {
  readonly name: string;
  readonly theaterId: string;
  readonly trigger: { readonly kind: "interval"; readonly minutes: number } | { readonly kind: "activity"; readonly operationId: string; readonly activity: ConsoleActivity };
  readonly action: ConsoleActionInput | { readonly kind: "briefing" };
  readonly expiresAt: string;
  readonly maxRuns: number;
}

export interface ConsoleAutomation {
  readonly id: string;
  readonly caller: ConsoleCaller;
  readonly input: ConsoleAutomationInput;
  readonly status: "active" | "paused" | "expired" | "exhausted";
  readonly runs: number;
  readonly createdAt: string;
  readonly nextRunAt?: string;
  readonly lastRunAt?: string;
  readonly lastError?: string;
  readonly briefing?: { readonly at: string; readonly total: number; readonly unknown: number; readonly counts: Readonly<Record<string, number>> };
}

export interface ConsoleControlState {
  readonly paused: boolean;
  readonly automations: readonly ConsoleAutomation[];
}
