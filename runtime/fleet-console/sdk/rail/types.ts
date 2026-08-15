import type { ReactNode } from "react";

import type { ConsoleLocale, LocalizedText } from "../i18n/types.js";
import type { ClientApiCapability, ConsoleTheme } from "../plugin/types.js";

/** @deprecated Rail panels now always operate at the Theater root. */
export interface RailPathContext {
  readonly kind: "root" | "worktree" | "directory";
  readonly relPath: string | null;
  readonly label: string;
}

export interface RailPanelContext {
  readonly theaterId: string | null;
  /** @deprecated Always the Theater-root context. */
  readonly pathContext: RailPathContext;
  /** @deprecated Path selection is no longer supported. */
  readonly selectPathContext?: (relPath: string | null) => void;
  readonly api: ClientApiCapability;
  readonly requestExtraWidth?: (px: number | null) => void;
  readonly language?: ConsoleLocale;
  readonly theme?: ConsoleTheme;
}

export interface RailSearchRequest {
  readonly query: string;
  readonly theaterId: string;
  readonly limit: number;
  readonly signal: AbortSignal;
  /** 결과 문자열을 로컬라이즈할 로케일 — 코어가 주입한다. */
  readonly language?: ConsoleLocale;
}

export interface RailSearchResult {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly activate: () => void | Promise<void>;
}

export type RailSearchProvider = (request: RailSearchRequest) => Promise<readonly RailSearchResult[]>;

export interface RailPanelDescriptor {
  readonly id: string;
  readonly title: LocalizedText;
  readonly icon: ReactNode | (() => ReactNode);
  readonly render: (ctx: RailPanelContext) => ReactNode;
  readonly search?: RailSearchProvider;
  readonly side?: "right";
  /** @deprecated Core ignores this field; every panel is Theater-root scoped. */
  readonly pathAware?: boolean;
  readonly defaultWidth?: number;
  readonly preferredExtraWidth?: number;
}
