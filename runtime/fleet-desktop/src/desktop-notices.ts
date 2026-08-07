/**
 * 화면을 갖지 않는 배관이 사람에게 말을 거는 유일한 자리. 성공은 조용한 알림으로 지나가도
 * 되지만 실패는 반드시 눈에 걸려야 하므로 모달로 올린다 — 원격 접속이 실패했다는 사실을
 * 놓치면 사용자는 로컬 콘솔을 원격이라고 착각한 채로 계속 쓴다.
 */
export interface DesktopNotice {
  readonly type: "info" | "error";
  readonly title: string;
  readonly body: string;
}

export interface DesktopNotifier {
  show(notice: DesktopNotice): void;
}

export interface ElectronNotificationFactory {
  isSupported(): boolean;
  new(options: { readonly title: string; readonly body: string }): { show(): void };
}

export interface DesktopNoticeDialog {
  showMessageBox(options: { readonly type: "info" | "error"; readonly title: string; readonly message: string; readonly buttons: string[] }): Promise<unknown>;
}

export function createDesktopNotifier(notification: ElectronNotificationFactory, dialog: DesktopNoticeDialog): DesktopNotifier {
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
