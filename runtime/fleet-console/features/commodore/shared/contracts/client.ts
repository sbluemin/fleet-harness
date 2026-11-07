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
  load(commodoreId: string): Promise<void>;
  open(commodoreId: string, options?: { readonly tab?: "log" | "info" | "memory" | "settings" | "goals"; readonly ask?: string; readonly revealAt?: number; readonly readOnly?: boolean; readonly objectiveId?: string; readonly mobile?: boolean }): boolean;
  language(): "en" | "ko" | undefined;
  conversationActive(): boolean;
  subscribeConversation(listener: () => void): () => void;
}
