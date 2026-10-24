import type { ReactNode } from "react";
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
  readonly decisionRequest: object | null;
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
}

export interface CommodoreBoardSnapshot {
  readonly loaded: boolean;
  readonly objectives: readonly CommodoreBoardObjective[];
}

export interface CommodoreBoardClient {
  readonly railEntryIds: readonly string[];
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
}
