import type { AttachmentHost } from "../../execution/shared/agent.js";
import type { ConsoleMcpTool } from "../../console-use/shared/tools.js";
import type { CommodoreScopeItem } from "../../commodore/shared/contracts/types.js";
export type CommodoreAttachmentReader = (ids: readonly string[]) => ReturnType<AttachmentHost["read"]>;

export type CommodorePersonMessageReader = () => boolean;

export type CommodoreBoardWakeCode = "settled" | "status" | "decision" | "review" | "criteria" | "pending" | "planned" | "followup" | "followup-failed" | "member-failed" | "stalled" | "empty" | "answered" | "returned" | "resume-failed";

export interface CommodoreWakeScope {
  readonly woke: readonly CommodoreScopeItem[];
  readonly held: readonly CommodoreScopeItem[];
}

export interface CommodoreTurnBindings {
  readonly readAttachments: CommodoreAttachmentReader;
  readonly hasPersonMessage: CommodorePersonMessageReader;
  stopping(): boolean;
}

export interface CommodoreWakeSink {
  /** 실험 기능이 꺼지면 보드 감시와 지휘관 정체 통지를 멈춘다. */
  automatic(): boolean;
  wake(code: CommodoreBoardWakeCode, input?: { readonly count?: number; readonly bump?: boolean; readonly detail?: string; readonly objectiveId?: string }): void;
  forget(objectiveId: string): void;
  stalledChanged(ids: readonly string[]): void;
  /**
   * 지난 종료가 듣지 못했다고 남긴 깨움 — 감시가 막 섰을 때 이미 대기 중인 그룹은 여기 든 목표(`all` 이면 모두)만 깨운다.
   * 없으면 기동만으로는 깨우지 않는다.
   */
  readonly unheard?: { readonly all: boolean; readonly objectiveIds: readonly string[] } | null;
}

/** 보드 의미·관측·자기 쓰기 판정의 수명은 어댑터가 소유한다. */
export interface CommodoreBoardWatch {
  recount(): ReadonlyMap<CommodoreBoardWakeCode, number>;
  scope(pending: ReadonlyMap<string, readonly string[]>): CommodoreWakeScope | null;
  emptyOperated(): boolean;
  /**
   * 이번 턴에 모델이 읽을 보드 요약 — 깨운 목표마다 단계·임무·대기·그룹 활동과 지난 턴 뒤의 단계 이동, 그리고 깨우지 않은 목표의
   * 단계 이동. 이동 기록은 이 호출이 비운다. 실을 것이 없으면 null.
   */
  brief(objectiveIds: readonly string[]): string | null;
  attribute(tool: ConsoleMcpTool, turn: CommodoreTurnBindings): ConsoleMcpTool;
  dispose(): void;
}

export interface CommodoreBoardAdapter {
  tools(commodoreId: string, turn: CommodoreTurnBindings): readonly ConsoleMcpTool[];
  watch(commodoreId: string, sink: CommodoreWakeSink): CommodoreBoardWatch;
  objective(commodoreId: string, id: string): { readonly id: string; readonly commodoreId: string; readonly title: string; readonly removed?: true } | null;
  language?(commodoreId: string): "en" | "ko" | null;
}

export interface CommodoreBoardHost {
  registerBoard(adapter: CommodoreBoardAdapter): () => void;
  commander(commodoreId: string): { readonly model: string; readonly effort?: string } | null;
}
