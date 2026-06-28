export interface NotificationKindDescriptor {
  readonly id: string;
  readonly title: string;
}

export interface ClientNotification {
  readonly kind: string;
  readonly operationId?: string;
  readonly message?: string;
}
