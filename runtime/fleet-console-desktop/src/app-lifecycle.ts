import type { App, BrowserWindow } from "electron";

export interface DesktopLifecycle { start(): Promise<void>; show(): void; prepareToQuit(): Promise<void>; quit(): Promise<void>; }

export function createDesktopLifecycle(app: App, createWindow: () => Promise<BrowserWindow>, stopSidecar: () => Promise<void>): DesktopLifecycle {
  let window: BrowserWindow | null = null;
  let windowCreation: Promise<BrowserWindow> | null = null;
  let quitPreparation: Promise<void> | null = null;

  const ensureWindow = (): Promise<BrowserWindow> => {
    if (window && !window.isDestroyed()) return Promise.resolve(window);
    if (!windowCreation) {
      windowCreation = createWindow().then((created) => {
        window = created;
        created.on("close", (event) => {
          if (!quitPreparation && process.platform !== "darwin") {
            event.preventDefault();
            created.hide();
          }
        });
        return created;
      }).finally(() => { windowCreation = null; });
    }
    return windowCreation;
  };
  const show = (): void => {
    if (window && !window.isDestroyed()) {
      revealWindow(window);
      return;
    }
    void ensureWindow().then((activeWindow) => {
      revealWindow(activeWindow);
    });
  };
  const prepareToQuit = (): Promise<void> => {
    if (!quitPreparation) {
      quitPreparation = stopSidecar().catch((error: unknown) => {
        quitPreparation = null;
        throw error;
      });
    }
    return quitPreparation;
  };
  const quit = async (): Promise<void> => {
    await prepareToQuit();
    app.quit();
  };
  const start = async (): Promise<void> => {
    app.on("activate", show);
    app.on("second-instance", show);
    app.on("window-all-closed", () => {
      if (process.platform === "darwin" && !quitPreparation) return;
      app.quit();
    });
    app.on("before-quit", (event) => {
      if (quitPreparation) return;
      event.preventDefault();
      void prepareToQuit().then(() => app.quit()).catch(() => undefined);
    });
    await ensureWindow();
  };
  return { start, show, prepareToQuit, quit };
}

function revealWindow(window: BrowserWindow): void {
  if (window.isMinimized?.()) window.restore();
  window.show();
  window.focus();
}
