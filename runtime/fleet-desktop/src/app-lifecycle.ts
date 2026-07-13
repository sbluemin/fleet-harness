import type { App, BrowserWindow } from "electron";

export interface DesktopLifecycle { attachWindow(window: BrowserWindow): void; start(): Promise<void>; show(): Promise<BrowserWindow>; prepareToQuit(): Promise<void>; quit(): Promise<void>; }

export function createDesktopLifecycle(app: App, createWindow: () => Promise<BrowserWindow>, stopSidecar: () => Promise<void>): DesktopLifecycle {
  let window: BrowserWindow | null = null;
  let windowCreation: Promise<BrowserWindow> | null = null;
  let quitPreparation: Promise<void> | null = null;
  const closeGuardAttached = new WeakSet<BrowserWindow>();

  const attachWindow = (created: BrowserWindow): void => {
    window = created;
    if (closeGuardAttached.has(created)) return;
    closeGuardAttached.add(created);
    created.on("close", (event) => {
      if (!quitPreparation && process.platform !== "darwin") {
        event.preventDefault();
        created.hide();
      }
    });
  };

  const ensureWindow = (): Promise<BrowserWindow> => {
    if (window && !window.isDestroyed()) return Promise.resolve(window);
    if (!windowCreation) {
      windowCreation = createWindow().then((created) => {
        attachWindow(created);
        return created;
      }).finally(() => { windowCreation = null; });
    }
    return windowCreation;
  };
  const show = async (): Promise<BrowserWindow> => {
    if (window && !window.isDestroyed()) {
      revealWindow(window);
      return window;
    }
    const activeWindow = await ensureWindow();
    revealWindow(activeWindow);
    return activeWindow;
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
    app.on("activate", () => { void show(); });
    app.on("second-instance", () => { void show(); });
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
  return { attachWindow, start, show, prepareToQuit, quit };
}

function revealWindow(window: BrowserWindow): void {
  if (window.isMinimized?.()) window.restore();
  window.show();
  window.focus();
}
