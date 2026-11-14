import type { ReactNode } from "react";
import type { ConversationConsultReply } from "../../execution/shared/conversation/types.js";

/** 사람에게 넘긴 대기 항목 — 목록 한 줄에 필요한 것만. 처리 UI는 `renderInboxDetail`이 그린다. */
export type CommodoreInboxKind = "criteria" | "review" | "followup";
export interface CommodoreInboxHold {
  readonly kind: CommodoreInboxKind;
  readonly at: number;
  readonly reason: string;
}
export type CommodoreBoardActor = "human" | "commander"
  | { readonly kind: "commodore"; readonly commodoreId: string; readonly why?: string }
  | { readonly kind: "objectiveRecord"; readonly objectiveId: string; readonly title: string | null };

/** 사령관 표면이 읽는 보드 투영. 보드 구현·판정 함수는 플러그인 밖으로 나오지 않는다. */
export interface CommodoreBoardObjective {
  readonly commodoreId: string;
  readonly id: string;
  readonly theaterId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly done: object | null;
  readonly removed: object | null;
  readonly commenced: boolean;
  readonly awaitingReview: boolean;
  readonly awaitingHandoff: boolean;
  /** 사람에게 넘겨 지금 사람이 답할 항목. 완료한 목표의 후속도 포함한다. 오래 기다린 순은 화면이 `at`으로 정한다. */
  readonly inboxHolds: readonly CommodoreInboxHold[];
  readonly missions: readonly { readonly done: unknown }[];
  readonly running: boolean;
  readonly waiting: boolean;
  readonly addedBy: { readonly objectiveId: string; readonly title: string | null } | Extract<CommodoreBoardActor, { kind: "commodore" }> | null;
  readonly actions?: readonly { readonly id: string; readonly at: number; readonly kind: string; readonly by: CommodoreBoardActor }[];
  readonly decisions: readonly {
    readonly id: string; readonly at: number; readonly by?: CommodoreBoardActor;
    readonly question: { readonly text: string; readonly options: readonly { readonly id: string; readonly label: string }[] };
    readonly answer: { readonly selectedOptionIds: readonly string[]; readonly text: string };
  }[];
  /** 지휘관이 이 사령관에게 구한 자문 — 답(`text` 가 null 이면 「추가 의견 없음」)과 지휘관에게 닿은 상태. */
  readonly consults?: readonly {
    readonly id: string; readonly question: string; readonly at: number;
    readonly reply?: { readonly text: string | null; readonly at: number; readonly delivery?: ConversationConsultReply["delivery"] };
  }[];
}

export interface CommodoreBoardSnapshot {
  readonly loaded: boolean;
  readonly objectives: readonly CommodoreBoardObjective[];
}

export interface CommodoreBoardClient {
  /** 사령관 요청이 인가된 서버에 닿았다 — 보드의 일시 조회 게이트도 같은 연결 증거를 받는다. */
  serverReached(): void;
  read(commodoreId: string): CommodoreBoardSnapshot;
  subscribe(listener: () => void): () => void;
  finished(commodoreId: string): readonly CommodoreBoardObjective[];
  finishedLoaded(commodoreId: string): boolean;
  findFinished(id: string): CommodoreBoardObjective | null;
  loadFinished(commodoreId: string): void;
  subscribeFinished(listener: () => void): () => void;
  openObjective(objectiveId: string, theaterId: string, done?: boolean): void;
  openObjectiveFromCluster(theaterId?: string, objectiveId?: string): void;
  openObjectiveOnPhone(objectiveId: string, theaterId?: string): void;
  revealObjective(input: { readonly objectiveId: string }): void;
  renderObjectiveAvatar(commodoreId: string, objectiveId: string, size: number): ReactNode;
  /** 넘긴 후속 후보 카드 — 채택·폐기·돌려주기는 보드의 사람용 경로 그대로다. `open` 은 그 목표로 가는 길. */
  renderHandedFollowup(objectiveId: string, options: { readonly language: "en" | "ko"; readonly phone: boolean; readonly open: () => void }): ReactNode;
  /** 넘긴 기준·검토를 그 자리에서 처리한다. 후속은 `renderHandedFollowup`. */
  renderInboxDetail(objectiveId: string, kind: Exclude<CommodoreInboxKind, "followup">, options: { readonly language: "en" | "ko"; readonly phone: boolean }): ReactNode;
}
