import type { ReactNode } from "react";

import type { ConsoleLocale } from "../i18n/types.js";
import type {
  ClientApiCapability,
  ClientLifecycleCapability,
  ClientPreferencesCapability,
} from "../plugin/types.js";

export interface FloatingWidgetContext {
  readonly api: ClientApiCapability;
  readonly lifecycle: ClientLifecycleCapability;
  readonly preferences: ClientPreferencesCapability;
  readonly language?: ConsoleLocale;
}

export interface FloatingWidgetDescriptor {
  readonly id: string;
  readonly render: (ctx: FloatingWidgetContext) => ReactNode;
}
