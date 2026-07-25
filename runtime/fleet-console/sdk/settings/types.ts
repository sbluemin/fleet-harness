import type { ReactNode } from "react";

import type { LocalizedText } from "../i18n/types.js";

export interface SettingsSectionDescriptor {
  readonly id: string;
  readonly title: LocalizedText;
  readonly render?: () => ReactNode;
}
