import type { ReactNode } from "react";

import type { ClientApiCapability } from "../plugin/types.js";

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
}

export interface RailPanelDescriptor {
  readonly id: string;
  readonly title: string;
  readonly icon: ReactNode | (() => ReactNode);
  readonly render: (ctx: RailPanelContext) => ReactNode;
  readonly side?: "right";
  /** @deprecated Core ignores this field; every panel is Theater-root scoped. */
  readonly pathAware?: boolean;
  readonly defaultWidth?: number;
  readonly preferredExtraWidth?: number;
}
