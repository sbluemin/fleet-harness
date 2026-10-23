import type { ClientNotification } from "./notifications.js";
export interface ClientNotificationsCapability {
  emit(notification: ClientNotification): void;
  dismiss(id: string): void;
}
