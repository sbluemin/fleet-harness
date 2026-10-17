/**
 * 화면을 갖지 않는 배관이 사람에게 말을 거는 유일한 자리. 성공은 조용한 알림으로 지나가도
 * 되지만 실패는 반드시 눈에 걸려야 하므로 모달로 올린다 — 원격 접속이 실패했다는 사실을
 * 놓치면 사용자는 로컬 콘솔을 원격이라고 착각한 채로 계속 쓴다.
 *
 * 다만 그 모달이 메인 프로세스를 세워서는 안 된다. macOS에서 부모 창 없는 `dialog.showMessageBox`는
 * 비동기 API여도 NSAlert `runModal`을 그 자리에서 돌리고(Electron shell/browser/ui/message_box_mac.mm),
 * 그 중첩 루프 동안 Chromium은 메인 스레드의 애플리케이션 작업을 실행하지 않는다 — 로그·IPC·CDP·종료 요청이
 * 전부 누군가 OK를 누를 때까지 멈춘다. 그래서 경고는 보이는 창에 시트로만 붙이고, 붙일 창이 없으면
 * 시스템 알림으로 낮춘다. 창 없는 대화상자는 그것이 막지 않는 플랫폼에서, 알림조차 없을 때만 쓴다.
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

export interface DesktopNoticeDialogOptions {
  readonly type: "info" | "error";
  readonly title: string;
  readonly message: string;
  readonly buttons: string[];
}

export interface DesktopNoticeDialog<Parent> {
  /** 시트로 붙는다 — 메인 스레드를 세우지 않는다. */
  showSheet(parent: Parent, options: DesktopNoticeDialogOptions): Promise<unknown>;
  /** 부모 없는 대화상자. macOS에서는 메인 스레드를 세우므로 `detachedDialogBlocks`가 거짓일 때만 부른다. */
  showDetached(options: DesktopNoticeDialogOptions): Promise<unknown>;
}

export interface DesktopNoticeDeps<Parent> {
  readonly notification: ElectronNotificationFactory;
  readonly dialog: DesktopNoticeDialog<Parent>;
  /** 지금 보이고 최소화되지 않은 창. 없으면 null — 숨은 창의 시트는 아무도 보지 못한다. */
  readonly parent: () => Parent | null;
  /** 부모 없는 대화상자가 메인 스레드를 세우는 플랫폼인가(macOS). */
  readonly detachedDialogBlocks: boolean;
  readonly log?: (message: string) => void;
}

export function createDesktopNotifier<Parent>(deps: DesktopNoticeDeps<Parent>): DesktopNotifier {
  const { notification, dialog } = deps;
  return {
    show: ({ title, body, type }) => {
      const options: DesktopNoticeDialogOptions = { type, title, message: body, buttons: ["OK"] };
      if (type === "error" || !notification.isSupported()) {
        const parent = deps.parent();
        if (parent !== null) {
          void dialog.showSheet(parent, options).catch(() => undefined);
          return;
        }
      }
      if (notification.isSupported()) {
        new notification({ title, body }).show();
        return;
      }
      if (!deps.detachedDialogBlocks) {
        void dialog.showDetached(options).catch(() => undefined);
        return;
      }
      // 보일 창도 알림도 없다. 메인 스레드를 세우느니 기록만 남긴다.
      deps.log?.(`desktop notice dropped (no visible window) type=${type} title=${title}`);
    },
  };
}
