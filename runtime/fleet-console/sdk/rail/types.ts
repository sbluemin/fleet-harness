import type { ReactNode } from "react";

import type { ClientApiCapability } from "../plugin/types.js";

export interface RailPanelContext {
  readonly theaterId: string | null;
  readonly api: ClientApiCapability;
}

export interface RailPanelDescriptor {
  readonly id: string;
  readonly title: string;
  readonly icon: ReactNode | (() => ReactNode);
  readonly render: (ctx: RailPanelContext) => ReactNode;
  readonly side?: "right";
}
