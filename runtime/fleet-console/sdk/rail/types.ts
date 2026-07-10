import type { ReactNode } from "react";

import type { ClientApiCapability } from "../plugin/types.js";

export interface RailPathContext {
  readonly kind: "root" | "worktree" | "directory";
  readonly relPath: string | null;
  readonly label: string;
}

export interface RailPanelContext {
  readonly theaterId: string | null;
  readonly pathContext: RailPathContext;
  readonly api: ClientApiCapability;
  readonly requestExtraWidth?: (px: number | null) => void;
}

export interface RailPanelDescriptor {
  readonly id: string;
  readonly title: string;
  readonly icon: ReactNode | (() => ReactNode);
  readonly render: (ctx: RailPanelContext) => ReactNode;
  readonly side?: "right";
  readonly pathAware?: boolean;
  readonly preferredExtraWidth?: number;
}
