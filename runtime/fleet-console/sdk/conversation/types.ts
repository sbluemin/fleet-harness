import type { ReactNode } from "react";

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
    /** 질문 위에 칩으로 서는 짧은 머리말. 없으면 서지 않는다. */
    readonly header?: string;
    readonly text: string;
    readonly multiSelect: boolean;
    readonly options: readonly { readonly id: string; readonly label: string; readonly description?: string }[];
  }[];
  /** 사람이 직접 쓰는 답 한 칸의 글자 수 상한 — 플러그인이 받는 상한을 그대로 건넨다. 없으면 호스트가 막지 않는다. */
  readonly answerMaxLength?: number;
  /** 결정 쓰기는 플러그인의 승인 표면을 통해서만 한다. */
  readonly open: () => void;
  /** 기존 보드 결정 제출 경로. 오래된 요청/전달 실패는 reject한다. */
  readonly answer?: (answers: readonly GroupDecisionAnswer[]) => Promise<void>;
  /** 지금 이 요청을 사람 대신 다루는 맡은 이의 한마디(예: 「사령관이 답하는 중」). 사람도 답할 수 있다. 머리 끝에 무채색으로 선다. */
  readonly handler?: LocalizedText;
  /**
   * 맡은 이가 이 요청을 사람에게 넘겼다 — `label` 은 머리말, `reason` 은 맡은 이가 쓴 넘긴 이유(번역하지 않는다). `giveBack` 이 있으면
   * 사람이 요청을 맡은 이에게 돌려주는 단추가 선다. 실패는 reject 한다.
   */
  readonly handed?: { readonly label: LocalizedText; readonly reason: string; readonly giveBack?: { readonly label: LocalizedText; readonly run: () => Promise<void> } };
  /** 보낸 답이 갈 곳 한 줄 — 보내기 단추 곁에 선다. */
  readonly route?: LocalizedText;
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
   * 모델·강도 한 줄 — `label` 은 모델 낱말(「Opus」), `effort` 는 강도 낱말(「HIGH」, 없으면 말하지 않는다)과 hover 풀네임, 공급자 글리프.
   * `struck` — 다음 기동에 쓰이지 않는 값(로스터에서 꺼진 모델)이라 모델 낱말에만 취소선을 긋는다. `badge` — 낱말 곁 표식(「꺼짐」·「폴백」).
   * `via` — 그 모델이 어떻게 정해졌는지의 표식(「라우팅」·「폴백」). `tone: "warn"` 은 의도와 다르게 정해진 경우다.
   */
  readonly launch?: {
    readonly label: LocalizedText;
    readonly effort?: LocalizedText;
    readonly title?: LocalizedText;
    readonly provider?: LaunchProviderGlyphId;
    readonly struck?: boolean;
    readonly badge?: LocalizedText;
    readonly via?: { readonly label: LocalizedText; readonly title?: LocalizedText; readonly tone?: "warn" };
  };
  readonly status?: { readonly text: LocalizedText; readonly tone?: "danger" };
  /**
   * 줄 아래의 진단 줄들 — 보드 행이 보이는 순서 그대로(예: 직전 턴 실패, 보고 경로 없음, 라우팅 폴백 사유). `title` 은 보드가 펼쳐 싣는
   * 원문이라 번역하지 않는다. `tone` 은 낱말의 신호 색이다.
   */
  readonly notes?: readonly { readonly text: LocalizedText; readonly title?: string; readonly tone?: "warn" | "danger" }[];
}

/** 플러그인이 보내는 명부 한 줄 — 발화자 표식에 보드 사실을 곁들인다. 호스트는 profile 을 참여자로 옮기고 발화자에서는 뗀다. */
export type ConversationMember = ConversationSpeaker & { readonly profile?: ConversationMemberProfile };

export interface ConversationParticipant {
  readonly speaker: ConversationSpeaker;
  readonly activity: "running" | "background" | "awaiting" | "idle" | "ended" | "unknown";
  readonly profile?: ConversationMemberProfile;
  /** 그 참여자 원장에서 지금 열린 턴의 좌표(메시지의 `turn` 과 같은 값). 아직 말이 없는 턴도 열린 순간부터 선다. 모르면 없다. */
  readonly turn?: string;
}

/** 덧붙인 말이 함께 간 보드 행위. */
export type ConversationMessageVia = "start" | "plan" | "steer";

type EntryCoordinate = { readonly id: string; readonly at: number | null };
export type GroupTimelineEntry = EntryCoordinate & (
  /**
   * `via` — 그 말이 함께 간 보드 행위(개시·구상·방향 수정). 사람·사령관이 그 행위에 덧붙인 말이면 선다.
   * `undelivered` — 받는 쪽이 끝내 받지 못한 사람의 말(꺼진 사령관에 남은 말 등). 말풍선에 「전달되지 않음」이 선다.
   * `turn` — 그 말을 한 발화자 원장의 턴 좌표. 같은 값이면 한 턴(지시 하나에 대한 응답)이다. 턴 접기가 읽고, 없으면 그 말은 접지 않는다.
   */
  | { readonly kind: "message"; readonly operationId: string; readonly speaker: ConversationSpeaker; readonly text: string; readonly format?: "markdown"; readonly attachments?: readonly ({ readonly id: string } | { readonly lapsed: true } | { readonly reference: string })[]; readonly streaming: boolean; readonly recipient?: ConversationSpeaker; readonly copied?: boolean; readonly via?: ConversationMessageVia; readonly undelivered?: true; readonly turn?: string }
  /**
   * 사람·사령관의 말 없이 플러그인이 혼자 보낸 지시(구성원 실패·미보고 알림 등). 발화자가 아니라 출처이므로 말풍선이 아닌
   * 가운데 줄로 선다. `pluginId` 는 출처 이름·표식을 고르는 열쇠일 뿐 화면에 그대로 쓰지 않는다.
   */
  | { readonly kind: "plugin-notice"; readonly operationId: string; readonly pluginId: string; readonly recipient: ConversationSpeaker; readonly text: string; readonly format?: "markdown" }
  /** `turn` — 보낸 쪽 원장에서 이 전언을 낸 턴(메시지의 `turn` 과 같은 좌표). 받은 쪽 원장만 본 전언에는 없다. */
  | { readonly kind: "delegation"; readonly sender: ConversationSpeaker; readonly recipients: readonly ConversationSpeaker[]; readonly text: string; readonly result: string; readonly ok?: boolean; readonly received: boolean; readonly turn?: string }
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
  /** 보드 동작 — 입력창 위 제안 줄. 보드가 없는 대화(목표가 아닌 채팅)에는 없다. */
  readonly board?: GroupBoardActions;
}

/** 제안 칩의 글리프 — 호스트가 입력창과 같은 선 굵기로 그린다. */
export type GroupBoardActionGlyph = "plan" | "start" | "steer" | "complete" | "handOff";

/** 제안 줄의 칩 하나 — 보드의 상태 사다리가 고른 사람의 할 일. */
export interface GroupBoardAction {
  /** `run` 이 돌려받는 열쇠. */
  readonly id: string;
  readonly label: LocalizedText;
  /** 칩 부제(예: 「구성원 7」·고친 보드 종류). */
  readonly detail?: LocalizedText;
  readonly glyph: GroupBoardActionGlyph;
  /** 지금 할 일 — `primary` 는 첫 칩, `review` 는 검토 대기의 완료다. 없으면 보조 칩이다. */
  readonly emphasis?: "primary" | "review";
  /**
   * 있으면 칩을 고를 때 입력창 안에 동작 칩이 앉고 쓰는 말이 곧 덧붙일 말이다. 그동안 받는 이는 지휘관으로 고정된다.
   * `prefill` 은 입력이 비었을 때 미리 채울 지난 말이다. 없으면 칩이 곧 실행이다.
   */
  readonly context?: { readonly placeholder: LocalizedText; readonly required: boolean; readonly maxLength: number; readonly prefill?: string };
  /** 말 없이 실행하는 칩을 두 번 눌러야 보낸다(첫 누름 뒤 잠시 안에 다시). */
  readonly confirm?: boolean;
  /** 지금 누를 수 없는 까닭 — 칩이 잠기고 이 말이 title 로 선다. */
  readonly unavailable?: LocalizedText;
}

/**
 * 보드 동작의 결과. `done` — 보냈다(입력창의 동작 칩과 덧붙일 말을 걷는다). `held` — 플러그인 패널(`renderPanel`)이 이어받았다
 * (말과 칩은 그대로 둔다). `failed` — 거절됐다(말을 지키고 자동 재시도하지 않는다). `notice` 는 입력창의 알림 줄로 선다.
 */
export interface GroupBoardRunResult {
  readonly outcome: "done" | "held" | "failed";
  readonly notice?: { readonly text: LocalizedText; readonly tone: "info" | "warn" };
}

/** 플러그인 패널이 받는 문맥 — 패널이 이어받은 동작을 끝내면 `settle` 로 입력창에 알린다. */
export interface GroupBoardPanelContext {
  readonly language: "en" | "ko";
  readonly settle: (result: GroupBoardRunResult) => void;
}

/**
 * 보드 동작의 계약. 상태 사다리·서버 경로·거절 사유의 문구는 플러그인이 소유하고, 호스트는 제안 줄·입력창 안 동작 칩·＋ 메뉴 행을
 * 그린다. 보내기↔정지(중단)와 받는 이 메시지는 `send`·`stopAll` 그대로다.
 */
export interface GroupBoardActions {
  /** 제안 줄의 칩 — 지금 할 일이 첫 칩, 함께 성립하는 보조가 둘째 칩이다. 비면 칩이 서지 않는다. */
  readonly suggestions: readonly GroupBoardAction[];
  /** 입력창이 이 동작으로 고정된다(완료한 목표의 범위 넓히기) — 칩을 풀 수 없고 받는 이를 고를 수 없다. */
  readonly fixed?: GroupBoardAction;
  /** 평범한 메시지가 갈 곳이 없다(지휘관이 서기 전) — 동작 칩을 고른 말만 보낸다. */
  readonly actionsOnly?: boolean;
  /**
   * 제안 줄 앞의 한 줄. `lock` — 잠긴 동작의 까닭(`reveal` 이 있으면 「보기」 링크), `working` — 진행 중 안내,
   * `awaiting` — 허용을 기다리는 참여자(호스트가 대화의 요청 카드로 가는 링크를 붙인다).
   */
  readonly note?: { readonly tone: "lock" | "working" | "awaiting"; readonly text: LocalizedText; readonly reveal?: { readonly label: LocalizedText; readonly run: () => void } };
  /** 칩 뒤의 짧은 안내(예: 「덧붙일 말은 입력창에」). */
  readonly hint?: LocalizedText;
  /** ＋ 메뉴의 컨텍스트 압축(/compact) 행 — 두 번 눌러 보낸다. `sessions` 는 보낼 곳의 수, 0 이면 행이 잠긴다. */
  readonly compact?: { readonly sessions: number; readonly run: () => Promise<GroupBoardRunResult> };
  readonly run: (actionId: string, context: string) => Promise<GroupBoardRunResult>;
  /** 입력창 바로 위에 뜨는 플러그인 칸(라우팅 확인·후속 후보 고르기). 띄울 것이 없으면 null 을 그린다. 자리와 면은 호스트가 진다. */
  readonly renderPanel?: (ctx: GroupBoardPanelContext) => ReactNode;
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
