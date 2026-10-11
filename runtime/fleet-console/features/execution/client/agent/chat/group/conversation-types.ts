/**
 * 임시 사본 — 그룹 대화 읽기 계약(임무 9 초안, `impl/group-timeline-contract.md`).
 *
 * 임무 9 커밋이 통합되면 이 파일을 지우고 `@fleet-console/sdk/conversation` 의 export 로 바꾼다.
 * 필드는 계약 문서와 한 글자도 다르지 않게 둔다 — 교체가 import 줄만 바꾸는 일이 되도록.
 */
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
