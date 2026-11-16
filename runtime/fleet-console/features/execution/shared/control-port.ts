import type { ConsoleActionInput, ConsoleActionResult, ConsoleCoordinates, ConsoleCoordinatesResult, ConsoleObjectiveObservation, ConsoleTranscriptPage, ConsoleTurnEnd } from "./control.js";
/**
 * 플러그인 제어 경로로 Objective 을 시작하거나 그 입력창에 메시지를 넣는 능력. 호출자는 이 플러그인
 * 자신이며(`{ kind: "plugin", pluginId }`), 목표의 `launchedBy`에는 `{ kind: "feature", featureId }`로 남는다. 시트를 거치지
 * 않는다 — `console_launcher` 가 쓰는 서버 경로 그대로다. 없는 호스트에서는 없다.
 */
export interface ConsoleControlHost {
  /** 전달이 끝날 때까지(objectiveId 또는 실패) 기다린다. 실패는 코드 문자열을 message 로 던진다. 결과는 남지 않고, 같은 입력을 다시 보내면 다시 실행된다. */
  request(input: ConsoleActionInput): Promise<ConsoleActionResult>;
  /** 한 Objective 의 지금 관측 — 활동·생명주기·표면·마지막 산출. 모르면 null. */
  observe(objectiveId: string): ConsoleObjectiveObservation | null;
  /** 소유한 세션의 종료 snapshot. 다음 턴이 곧 시작해도 polling이 실패를 놓치지 않는다. */
  subscribeTurnEnds?(listener: (event: ConsoleTurnEnd) => void): () => void;
  /** 소유한 채팅의 SDK 주소를 명시적으로 준비한다. 모델 턴이나 lifecycle 전이는 없으며 실패는 코드로 던진다. */
  prepareChat?(objectiveId: string): Promise<void>;
  /** capture 전인 유휴 채팅의 프리셋. 자식이 없으면 저장 좌표만 바꾸고, 자식이 있으면 기존 소유 검사를 적용한다. */
  setUnstartedPreset?(objectiveId: string, input: { readonly model: string; readonly effort: string | null }): Promise<ConsoleCoordinatesResult>;
  /**
   * 이미 있는 Objective의 다음 프로세스 기동(휴면 재개·채팅을 새로 띄우는 실행)에 쓸 서브에이전트 정책.
   * live 프로세스는 중단하지 않고, 세션 스냅샷도 바꾸지 않는다. 없는 Objective은 무시한다.
   * `blocked`는 강제 차단, `default`는 그 차단을 걷고 전역 정책만 적용한다.
   */
  setSubagentSpawn?(objectiveId: string, policy: "blocked" | "default"): void;
  /**
   * @deprecated Console이 띄우는 Claude 세션은 사람에게 묻는 도구(`AskUserQuestion`)를 늘 빼므로 정할 정책이 없다.
   * 호스트는 이 메서드를 제공하지 않는다 — 옛 플러그인의 `?.()` 호출은 아무 일도 하지 않는다.
   */
  setUserQuestions?(objectiveId: string, policy: "blocked" | "default"): void;
  /**
   * 떠 있는 채팅 세션의 모델·강도를 바꾼다 — 채팅 화면의 모델 메뉴와 같은 후보·같은 검증을 지난다. 턴이 도는 중이면 그 턴이 닫히는
   * 경계로 미루고(`scheduled`), 지금 실행값을 다시 고르면 예약을 거둔다. 이 플러그인이 띄운 Objective(또는 그 자식)만 받는다 —
   * 아니면 `forbidden`. `effort` 는 런치 어휘이며 null 은 모델 기본이다. 자식이 없으면 저장 좌표만 바꾸고 다음 기동에 적용한다. 터미널은 `chat_not_active` 다.
   */
  setCoordinates?(objectiveId: string, input: { readonly model: string; readonly effort: string | null }): Promise<ConsoleCoordinatesResult>;
  /** 떠 있는 채팅 세션의 지금 좌표와 예약. 떠 있는 채팅이 아니면 null. */
  coordinates?(objectiveId: string): ConsoleCoordinates | null;
  /**
   * 이 플러그인이 띄운 떠 있는 채팅 세션이 init 에서 모델에게 광고한 도구 이름. 아직 모르거나(미기동·init 전·터미널) 남의 세션이면 null —
   * null 은 「도구가 없다」가 아니다.
   */
  advertisedTools?(objectiveId: string): readonly string[] | null;
  /**
   * Agent Objective 의 전사 한 쪽 — transcript 읽기와 같은 줄(사람의 말·답·도구·질문·턴 결말)이고
   * 본문은 자격증명 마스킹을 지난 신뢰할 수 없는 데이터다. 이 플러그인이 띄운 Objective(또는 그 자식)만 받는다 — 아니면 `forbidden`.
   * 커서 없이 `tail` 이면 마지막 `limit` 줄(그 앞이 남았으면 truncated)이고, 아니면 커서부터 앞으로 읽는다.
   */
  transcript?(objectiveId: string, input: { readonly cursor?: string; readonly limit: number; readonly tail?: boolean }, signal?: AbortSignal): Promise<ConsoleTranscriptPage | { readonly error: string }>;
  /** 다음 열기에서 이전 대화를 싣지 않는 새 세션으로 열도록 표시를 남긴다. */
  markNextOpenFresh?(objectiveId: string): void;
  /** 다음 열기가 새 세션으로 예정되어 있는지 확인한다(안내 표시를 확인하며 소비하지 않는다). */
  isNextOpenFresh?(objectiveId: string): boolean;
  /** 새 세션 첫 턴 안내 표시를 소비한다. */
  consumeFreshNotice?(objectiveId: string): boolean;
  /** 살아 있는 채팅 자식 인스턴스를 dispose한다(중단 뒤 재개 등에서 새 세션으로 열기 위함). */
  disposeChat?(objectiveId: string): Promise<void>;
}
