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
   * `text` 다. 플러그인이 모델용 구조화 프롬프트와 사람용 요약을 갈라 보낼 때 쓴다.
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
  /**
   * launch 전용·플러그인 호출자 전용 — 멱등 기동 키(`[A-Za-z0-9._:-]{1,128}`, 호출 플러그인 범위). 같은 키로는 Operation 이 많아야
   * 하나 생긴다: 살아 있으면 그 Operation 을 돌려주고, 삭제됐으면(유예 중·purge) `launch_key_deleted` 로 거절한다. 키는 생성과
   * 함께 영속되며 만료하지 않는다. 새 키는 소유자별 용량 안에서만 받는다(`launch_key_capacity`).
   */
  readonly launchKey?: string;
}

export interface ConsoleOperationObservation {
  readonly activity: ConsoleActivity;
  readonly lifecycle: "live" | "dormant" | "unknown";
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
  };
}

export interface ConsoleActionReceipt {
  readonly id: string;
  readonly requestId: string;
  readonly caller: ConsoleCaller;
  readonly input: ConsoleActionInput;
  readonly status: "accepted" | "running" | "finished" | "rejected" | "failed" | "outcome_unknown";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly operationId?: string;
  readonly policyId?: string;
  readonly error?: string;
  readonly outcome?: "completed" | "succeeded" | "failed" | "interrupted";
  readonly delivery?: "queued" | "confirmed" | "requested";
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
  readonly actions: readonly ConsoleActionReceipt[];
  readonly automations: readonly ConsoleAutomation[];
  readonly retention: { readonly actionDays: number; readonly actionLimit: number; readonly deduplication: "retained_receipts" };
}
