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
  read(theaterId: string): CommodoreClientSnapshot;
  subscribe(listener: () => void): () => void;
  revision(): number;
  askTheaters(): readonly string[];
  load(theaterId: string): Promise<void>;
  open(theaterId: string, options?: { readonly tab?: "log" | "directive" | "memory" | "settings" | "goals"; readonly ask?: string; readonly revealAt?: number; readonly readOnly?: boolean; readonly objectiveId?: string; readonly mobile?: boolean }): boolean;
  language(): "en" | "ko" | undefined;
  conversationActive(): boolean;
  subscribeConversation(listener: () => void): () => void;
  renderRowGlyph(theaterId: string, operated?: boolean): ReactNode;
}
