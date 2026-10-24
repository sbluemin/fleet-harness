import type { AttachmentHost } from "../../execution/shared/agent.js";
import type { ConsoleMcpTool } from "../../console-use/shared/tools.js";
import type { CommodoreScopeItem } from "../../commodore/shared/contracts/types.js";
export type CommodoreAttachmentReader = (ids: readonly string[]) => ReturnType<AttachmentHost["read"]>;

export type CommodorePersonMessageReader = () => boolean;

export type CommodoreBoardWakeCode = "status" | "decision" | "review" | "criteria" | "pending" | "planned" | "followup" | "followup-failed" | "member-failed" | "stalled" | "empty" | "answered" | "returned";

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
  /** 순찰 안 함에서는 보드 감시와 지휘관 정체 통지도 자동 실행하지 않는다. */
  automatic(): boolean;
  wake(code: CommodoreBoardWakeCode, input?: { readonly count?: number; readonly bump?: boolean; readonly detail?: string; readonly objectiveId?: string }): void;
  forget(objectiveId: string): void;
  stalledChanged(ids: readonly string[]): void;
}

/** 보드 의미·관측·자기 쓰기 판정의 수명은 어댑터가 소유한다. */
export interface CommodoreBoardWatch {
  recount(): ReadonlyMap<CommodoreBoardWakeCode, number>;
  scope(pending: ReadonlyMap<string, readonly string[]>): CommodoreWakeScope | null;
  emptyOperated(): boolean;
  attribute(tool: ConsoleMcpTool, turn: CommodoreTurnBindings): ConsoleMcpTool;
  dispose(): void;
}

export interface CommodoreBoardAdapter {
  tools(theaterId: string, turn: CommodoreTurnBindings): readonly ConsoleMcpTool[];
  watch(theaterId: string, sink: CommodoreWakeSink): CommodoreBoardWatch;
  objective(theaterId: string, id: string): { readonly id: string; readonly theaterId: string; readonly title: string; readonly removed?: true } | null;
  language?(theaterId: string): "en" | "ko" | null;
}

export interface CommodoreBoardHost {
  registerBoard(adapter: CommodoreBoardAdapter): () => void;
  commander(theaterId: string): { readonly model: string; readonly effort?: string } | null;
}
