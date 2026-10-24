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
  /** 서 있는 질문이 있는 화면 문맥(Theater). 사령관의 정체성이 아니다. */
  askTheaters(): readonly string[];
  load(commodoreId: string): Promise<void>;
  open(commodoreId: string, options?: { readonly tab?: "log" | "directive" | "memory" | "settings" | "goals"; readonly ask?: string; readonly revealAt?: number; readonly readOnly?: boolean; readonly objectiveId?: string; readonly mobile?: boolean }): boolean;
  /** Theater 머리·사이드바에서 그 화면의 사령관 UUID를 구한다. 없으면 null. */
  resolveContext(theaterId: string): Promise<string | null>;
  /** 이미 풀어 둔 화면 문맥의 사령관 UUID. 아직 모르면 null. */
  ownerOfContext(theaterId: string): string | null;
  language(): "en" | "ko" | undefined;
  conversationActive(): boolean;
  subscribeConversation(listener: () => void): () => void;
  renderRowGlyph(commodoreId: string, operated?: boolean): ReactNode;
}
