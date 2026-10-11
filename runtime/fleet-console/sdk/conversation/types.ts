/** 그룹 대화의 읽기 계약. 실행 원장과 플러그인 보드를 복제 저장하지 않는 표시 모델이다. */
export type ConversationSpeakerKind = "human" | "commander" | "member" | "commodore" | "operation";

export interface ConversationSpeaker {
  readonly kind: ConversationSpeakerKind;
  readonly name: string;
  readonly operationId?: string;
  readonly mark?: { readonly number: number; readonly tone: string };
}

export interface ConversationPreview {
  readonly text: string;
  readonly at: number | null;
  readonly kind: "message" | "decision";
  readonly speaker?: ConversationSpeaker;
}

export interface ConversationDecision {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly questions: readonly {
    readonly id: string;
    readonly text: string;
    readonly multiSelect: boolean;
    readonly options: readonly { readonly id: string; readonly label: string; readonly description?: string }[];
  }[];
  /** 결정 쓰기는 플러그인의 승인 표면을 통해서만 한다. */
  readonly open: () => void;
}

export interface ConversationParticipant {
  readonly speaker: ConversationSpeaker;
  readonly activity: "running" | "background" | "awaiting" | "idle" | "ended" | "unknown";
}

type EntryCoordinate = { readonly id: string; readonly at: number | null };
export type GroupTimelineEntry = EntryCoordinate & (
  | { readonly kind: "message"; readonly operationId: string; readonly speaker: ConversationSpeaker; readonly text: string; readonly format?: "markdown"; readonly streaming: boolean }
  | { readonly kind: "delegation"; readonly sender: ConversationSpeaker; readonly recipients: readonly ConversationSpeaker[]; readonly text: string; readonly result: string; readonly ok?: boolean; readonly received: boolean }
  | { readonly kind: "member-joined" | "member-left"; readonly speaker: ConversationSpeaker }
  | { readonly kind: "board-action"; readonly speaker: ConversationSpeaker; readonly objectiveId: string; readonly action: string; readonly text: string }
);

/** Objectives 등 플러그인이 기존 OperationCluster 포트로 보내는 보드 사실. */
export interface OperationClusterConversation {
  readonly operationId: string;
  readonly members: readonly ConversationSpeaker[];
  readonly events: readonly GroupTimelineEntry[];
  readonly truncated?: boolean;
  readonly decision: ConversationDecision | null;
}

export interface GroupTimelineSnapshot {
  readonly rootOperationId: string | null;
  readonly entries: readonly GroupTimelineEntry[];
  readonly participants: readonly ConversationParticipant[];
  readonly working: readonly ConversationSpeaker[];
  readonly decision: ConversationDecision | null;
  readonly preview: ConversationPreview | null;
  readonly loading: boolean;
  readonly truncated: boolean;
  readonly unavailableOperationIds: readonly string[];
}
