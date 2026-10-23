import type { LocalizedText } from "@fleet-console/i18n";

export interface NotificationKindDescriptor {
  readonly id: string;
  readonly title: LocalizedText;
}

export interface ClientNotification {
  readonly kind: string;
  readonly operationId?: string;
  readonly message?: string;
}
