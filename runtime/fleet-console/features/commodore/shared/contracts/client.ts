import type { ReactNode } from "react";
import type { CommodoreAsk, CommodoreStateView } from "./types.js";
export interface CommodoreClientSnapshot {
  readonly commodoreId: string | null;
  readonly active: boolean;
  readonly stalled: readonly string[];
  readonly enabled: boolean;
  readonly peek: boolean;
  readonly view: CommodoreStateView | null;
  readonly asks: readonly CommodoreAsk[];
}

export interface CommodoreClientHost {
  read(commodoreId: string): CommodoreClientSnapshot;
  subscribe(listener: () => void): () => void;
  revision(): number;
  /** Theater 등록 수와 독립된 사령관 UUID 목록. */
  ids(): readonly string[];
  /** 답을 기다리는 질문을 가진 사령관 UUID 목록. 화면 문맥 수와 독립적이다. */
  askOwners(): readonly string[];
  load(commodoreId: string): Promise<void>;
  open(commodoreId: string, options?: { readonly tab?: "log" | "directive" | "memory" | "settings" | "goals"; readonly ask?: string; readonly revealAt?: number; readonly readOnly?: boolean; readonly objectiveId?: string; readonly mobile?: boolean }): boolean;
  language(): "en" | "ko" | undefined;
  conversationActive(): boolean;
  subscribeConversation(listener: () => void): () => void;
  renderRowGlyph(commodoreId: string, operated?: boolean): ReactNode;
}
