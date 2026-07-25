import type { LocalizedText } from "../i18n/types.js";

export interface NotificationKindDescriptor {
  readonly id: string;
  readonly title: LocalizedText;
}

export interface ClientNotification {
  readonly kind: string;
  readonly operationId?: string;
  readonly message?: string;
}
