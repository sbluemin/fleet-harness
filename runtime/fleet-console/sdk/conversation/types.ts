import type { LaunchProviderGlyphId } from "../components/launch-provider-glyphs.js";
import type { LocalizedText } from "../i18n/types.js";

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
  /** 기존 보드 결정 제출 경로. 오래된 요청/전달 실패는 reject한다. */
  readonly answer?: (answers: readonly GroupDecisionAnswer[]) => Promise<void>;
}

/**
 * 명부 줄에 보드가 보이는 사실 — 플러그인이 자기 보드와 같은 표시 문자열로 채운다. 표시 문자열의 변환은 플러그인 한 곳에만 있고,
 * 호스트는 받은 글을 그대로 그린다. 모든 칸은 선택이다 — 없으면 그 칸이 서지 않는다.
 * `status` 는 상태 낱말만 바꾼다. 상태 점은 호스트가 관측한 활동 그대로다.
 */
export interface ConversationMemberProfile {
  /** 역할 곁의 작은 표식(예: 「지휘관 제안」). */
  readonly badge?: LocalizedText;
  /** 맡은 일의 한두 줄 설명. 사람이 쓴 글이라 번역하지 않는다. */
  readonly brief?: string;
  /**
   * 모델·강도 한 줄(「Opus · HIGH」)과 hover 풀네임, 공급자 글리프.
   * `struck` — 다음 기동에 쓰이지 않는 값(로스터에서 꺼진 모델)이라 낱말에 취소선을 긋는다. `badge` — 낱말 곁 표식(「꺼짐」·「폴백」).
   * `via` — 그 모델이 어떻게 정해졌는지의 표식(「라우팅」·「폴백」). `tone: "warn"` 은 의도와 다르게 정해진 경우다.
   */
  readonly launch?: {
    readonly label: LocalizedText;
    readonly title?: LocalizedText;
    readonly provider?: LaunchProviderGlyphId;
    readonly struck?: boolean;
    readonly badge?: LocalizedText;
    readonly via?: { readonly label: LocalizedText; readonly title?: LocalizedText; readonly tone?: "warn" };
  };
  readonly status?: { readonly text: LocalizedText; readonly tone?: "danger" };
  /** 줄 아래의 사유 한 줄(예: 라우팅 폴백 사유). hover 는 원문이다. */
  readonly note?: { readonly text: LocalizedText; readonly title?: string; readonly tone?: "warn" };
}

/** 플러그인이 보내는 명부 한 줄 — 발화자 표식에 보드 사실을 곁들인다. 호스트는 profile 을 참여자로 옮기고 발화자에서는 뗀다. */
export type ConversationMember = ConversationSpeaker & { readonly profile?: ConversationMemberProfile };

export interface ConversationParticipant {
  readonly speaker: ConversationSpeaker;
  readonly activity: "running" | "background" | "awaiting" | "idle" | "ended" | "unknown";
  readonly profile?: ConversationMemberProfile;
}

/** 덧붙인 말이 함께 간 보드 행위. */
export type ConversationMessageVia = "start" | "plan" | "steer";

type EntryCoordinate = { readonly id: string; readonly at: number | null };
export type GroupTimelineEntry = EntryCoordinate & (
  /**
   * `via` — 그 말이 함께 간 보드 행위(개시·구상·방향 수정). 사람·사령관이 그 행위에 덧붙인 말이면 선다.
   * `undelivered` — 받는 쪽이 끝내 받지 못한 사람의 말(꺼진 사령관에 남은 말 등). 말풍선에 「전달되지 않음」이 선다.
   */
  | { readonly kind: "message"; readonly operationId: string; readonly speaker: ConversationSpeaker; readonly text: string; readonly format?: "markdown"; readonly attachments?: readonly ({ readonly id: string } | { readonly lapsed: true } | { readonly reference: string })[]; readonly streaming: boolean; readonly recipient?: ConversationSpeaker; readonly copied?: boolean; readonly via?: ConversationMessageVia; readonly undelivered?: true }
  /**
   * 사람·사령관의 말 없이 플러그인이 혼자 보낸 지시(구성원 실패·미보고 알림 등). 발화자가 아니라 출처이므로 말풍선이 아닌
   * 가운데 줄로 선다. `pluginId` 는 출처 이름·표식을 고르는 열쇠일 뿐 화면에 그대로 쓰지 않는다.
   */
  | { readonly kind: "plugin-notice"; readonly operationId: string; readonly pluginId: string; readonly recipient: ConversationSpeaker; readonly text: string; readonly format?: "markdown" }
  | { readonly kind: "delegation"; readonly sender: ConversationSpeaker; readonly recipients: readonly ConversationSpeaker[]; readonly text: string; readonly result: string; readonly ok?: boolean; readonly received: boolean }
  | { readonly kind: "member-joined" | "member-left"; readonly speaker: ConversationSpeaker }
  | { readonly kind: "board-action"; readonly speaker: ConversationSpeaker; readonly objectiveId: string; readonly action: string; readonly text: string }
);

/** Objectives 등 플러그인이 기존 OperationCluster 포트로 보내는 보드 사실. */
export interface OperationClusterConversation {
  readonly operationId: string;
  readonly members: readonly ConversationMember[];
  /** 지휘관 줄의 보드 사실 — 보드가 지휘관 행에 보이는 것만 싣는다. */
  readonly commander?: ConversationMemberProfile;
  readonly events: readonly GroupTimelineEntry[];
  readonly truncated?: boolean;
  readonly decision: ConversationDecision | null;
  /**
   * 보드 사건(`board-action`) 줄에서 그 행위의 기록을 연다 — 사령관 행위면 읽기 전용 사령관 기록을 그 턴 위치로. 쓰기는 없다.
   * 플러그인이 줄 id 로 자기 기록을 찾는다. 없으면 그 줄은 펼침만 있다.
   */
  readonly openBoardAction?: (entryId: string) => void;
  readonly actions?: GroupConversationActions;
}

export type GroupMessageTarget =
  | { readonly kind: "commander" }
  | { readonly kind: "member"; readonly operationId: string }
  | { readonly kind: "all" }
  | { readonly kind: "commodore" };
export interface GroupDecisionAnswer {
  readonly questionId: string;
  readonly selectedOptionIds: readonly string[];
  readonly text: string;
}
export interface GroupWriteResult {
  readonly targets: readonly { readonly targetId: string; readonly outcome: "sent" | "stopped" | "skipped" | "failed"; readonly reason?: string }[];
  readonly commanderNotified?: boolean;
}
export interface GroupConversationActions {
  /**
   * `attachmentIds` 는 사람이 입력창에 올린 이미지(실행 기능의 런치 첨부 id)다. 지휘관 또는 구성원 한 명에게만 실린다 —
   * id 하나는 한 세션에만 묶이므로 「모두」·사령관 받는 이에는 입력창이 싣지 않는다.
   */
  readonly send: (target: GroupMessageTarget, text: string, attachmentIds?: readonly string[]) => Promise<GroupWriteResult>;
  readonly stopAll: () => Promise<GroupWriteResult>;
  readonly answerDecision: (requestId: string, answers: readonly GroupDecisionAnswer[]) => Promise<void>;
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
