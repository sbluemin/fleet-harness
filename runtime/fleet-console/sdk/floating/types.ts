import type { ReactNode } from "react";

import type { ConsoleLocale } from "../i18n/types.js";
import type {
  ClientApiCapability,
  ClientLifecycleCapability,
  ClientPreferencesCapability,
} from "../plugin/types.js";

export interface FloatingWidgetArrival {
  readonly operationId: string;
  readonly title: string;
}

export interface FloatingWidgetArrivalsCapability {
  list(): readonly FloatingWidgetArrival[];
  subscribe(listener: (arrivals: readonly FloatingWidgetArrival[]) => void): () => void;
}

export interface FloatingWidgetContext {
  readonly api: ClientApiCapability;
  readonly arrivals: FloatingWidgetArrivalsCapability;
  readonly lifecycle: ClientLifecycleCapability;
  readonly preferences: ClientPreferencesCapability;
  readonly language?: ConsoleLocale;
}

export interface FloatingWidgetDescriptor {
  readonly id: string;
  readonly render: (ctx: FloatingWidgetContext) => ReactNode;
}
