import type { RuntimePairingNotifier } from "./runtime-pairing.js";

export interface ElectronNotificationFactory {
  isSupported(): boolean;
  new(options: { readonly title: string; readonly body: string }): { show(): void };
}

export interface PairingDialog {
  showMessageBox(options: { readonly type: "info" | "error"; readonly title: string; readonly message: string; readonly buttons: string[] }): Promise<unknown>;
}

export function createPairingNotifier(notification: ElectronNotificationFactory, dialog: PairingDialog): RuntimePairingNotifier {
  return {
    show: ({ title, body, type }) => {
      if (type === "error" || !notification.isSupported()) {
        void dialog.showMessageBox({ type, title, message: body, buttons: ["OK"] });
        return;
      }
      new notification({ title, body }).show();
    },
  };
}
