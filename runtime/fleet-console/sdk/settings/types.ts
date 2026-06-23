import type { ReactNode } from "react";

export interface SettingsSectionDescriptor {
  readonly id: string;
  readonly title: string;
  readonly render?: () => ReactNode;
}
