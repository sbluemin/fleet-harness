import type { RuntimePairingNotifier } from "./runtime-pairing.js";

export interface ElectronNotificationFactory {
  isSupported(): boolean;
  new(options: { readonly title: string; readonly body: string }): { show(): void };
}

export interface PairingDialog {
  showMessageBox(options: { readonly type: "info" | "error"; readonly title: string; readonly message: string; readonly buttons: string[] }): Promise<unknown>;
}

export function createPairingNotifier(notification: ElectronNotificationFactory, dialog: PairingDialog): RuntimePairingNotifier {
  if (notification.isSupported()) return { show: ({ title, body }) => new notification({ title, body }).show() };
  return { show: ({ title, body, type }) => { void dialog.showMessageBox({ type, title, message: body, buttons: ["OK"] }); } };
}
