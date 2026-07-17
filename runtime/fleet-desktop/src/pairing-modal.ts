import type { BrowserWindow, BrowserWindowConstructorOptions, Event, WebContents } from "electron";

export const PAIRING_SCHEME = "fleet-desktop-pairing:";
const PAIRING_PARTITION = "fleet-desktop-pairing";

export interface PairingModal {
  prompt(parent: BrowserWindow, rememberedTarget?: string | null): Promise<string | null>;
}

export interface PairingModalDependencies {
  readonly BrowserWindow: typeof BrowserWindow;
  readonly pairingPagePath: string;
}

interface PairingModalWindow extends BrowserWindow {
  readonly webContents: WebContents;
}

// 이 모달은 렌더러 코드 없이 폼 이동만 받아, 사용자 입력이 IPC나 실행 문자열을 통과하지 않게 한다.
export function createPairingModal(dependencies: PairingModalDependencies): PairingModal {
  let active: { readonly window: PairingModalWindow; readonly result: Promise<string | null>; ready: boolean } | null = null;

  return {
    prompt(parent, rememberedTarget = null): Promise<string | null> {
      if (active && !active.window.isDestroyed()) {
        if (active.ready) active.window.show();
        active.window.focus();
        return active.result;
      }
      active = null;
      const modal = new dependencies.BrowserWindow(createPairingModalOptions(parent)) as PairingModalWindow;
      let resolveResult: (value: string | null) => void = () => undefined;
      let settled = false;
      let shortcutsIgnored = false;
      let cleanupContents = (): void => undefined;
      const result = new Promise<string | null>((resolve) => { resolveResult = resolve; });
      const onParentClosed = (): void => finish(null);
      const onModalClosed = (): void => finish(null, false);
      const finish = (value: string | null, destroy = true): void => {
        if (settled) return;
        settled = true;
        if (active?.window === modal) active = null;
        parent.removeListener("closed", onParentClosed);
        modal.removeListener("closed", onModalClosed);
        cleanupContents();
        if (shortcutsIgnored && !parent.isDestroyed()) {
          try { parent.webContents.setIgnoreMenuShortcuts(false); } catch { /* 부모 종료 중에는 복원이 불가능할 수 있다. */ }
        }
        shortcutsIgnored = false;
        resolveResult(value);
        if (destroy && !modal.isDestroyed()) modal.destroy();
      };
      const receiveNavigation = (event: Event, url: string, isMainFrame = true): void => {
        event.preventDefault();
        if (!isMainFrame) return;
        const value = parsePairingNavigation(url);
        if (value !== undefined) finish(value);
      };

      cleanupContents = configurePairingContents(modal.webContents, receiveNavigation, finish);
      modal.once("ready-to-show", () => {
        if (settled || modal.isDestroyed()) return;
        if (active?.window === modal) active.ready = true;
        modal.show();
        modal.focus();
      });
      modal.once("closed", onModalClosed);
      parent.once("closed", onParentClosed);
      active = { window: modal, result, ready: false };
      try {
        if (!parent.isDestroyed()) {
          parent.webContents.setIgnoreMenuShortcuts(true);
          shortcutsIgnored = true;
        }
        modal.setMenu(null);
        modal.webContents.setIgnoreMenuShortcuts(true);
      } catch {
        finish(null);
        return result;
      }
      void modal.loadFile(dependencies.pairingPagePath)
        .then(async () => {
          const host = rememberedSshHost(rememberedTarget);
          if (!host || settled || modal.isDestroyed()) return;
          await modal.webContents.executeJavaScript(createRememberedSshPrefillScript(host)).catch(() => undefined);
        })
        .catch(() => finish(null));
      return result;
    },
  };
}

function rememberedSshHost(target: string | null): string | null {
  return target?.startsWith("ssh:") && target.length > 4 ? target.slice(4) : null;
}

function createRememberedSshPrefillScript(host: string): string {
  const value = JSON.stringify(host).replace(/[<>&\u2028\u2029]/g, (character) => ({ "<": "\\u003c", ">": "\\u003e", "&": "\\u0026", "\u2028": "\\u2028", "\u2029": "\\u2029" })[character] ?? character);
  return String.raw`(() => {
  const mode = document.getElementById("mode-ssh");
  const input = document.getElementById("ssh-host");
  if (!(mode instanceof HTMLInputElement) || !(input instanceof HTMLInputElement)) return;
  mode.checked = true;
  input.value = ${value};
})();`;
}

export function createPairingModalOptions(parent: BrowserWindow): BrowserWindowConstructorOptions {
  return {
    parent,
    modal: true,
    show: false,
    width: 460,
    height: 330,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      devTools: false,
      partition: PAIRING_PARTITION,
    },
  };
}

export function parsePairingNavigation(value: string): string | null | undefined {
  if (/[\t\n\r ]/u.test(value)) return undefined;
  if (value === "fleet-desktop-pairing://cancel/") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== PAIRING_SCHEME || url.username || url.password || url.port || url.hash) return undefined;
    if (url.hostname !== "submit" || url.pathname !== "/") return undefined;
    const rawSearch = value.slice("fleet-desktop-pairing://submit/".length);
    const loopback = /^\?target=([^&#]*)$/u.exec(rawSearch) ?? /^\?mode=loopback&target=([^&#]*)$/u.exec(rawSearch);
    if (loopback) return decodeRawTarget(loopback[1]!);
    const ssh = /^\?mode=ssh&host=([^&#]*)$/u.exec(rawSearch);
    if (!ssh) return undefined;
    const host = decodeRawTarget(ssh[1]!);
    return host === undefined ? undefined : `ssh:${host}`;
  } catch {
    return undefined;
  }
}

function decodeRawTarget(raw: string): string | undefined {
  try {
    const value = decodeURIComponent(raw);
    return /[\u0000-\u001f\u007f\s]/u.test(value) ? undefined : value;
  } catch {
    return undefined;
  }
}

function configurePairingContents(contents: WebContents, receiveNavigation: (event: Event, url: string, isMainFrame?: boolean) => void, finish: (value: null) => void): () => void {
  const onNavigate = (event: Event, url: string, _isInPlace: boolean, isMainFrame: boolean): void => receiveNavigation(event, url, isMainFrame);
  const onRedirect = (event: Event): void => event.preventDefault();
  const onInput = (event: Event, input: Electron.Input): void => {
    if (input.type === "keyDown" && input.key === "Escape") {
      event.preventDefault();
      finish(null);
    }
  };
  const onDownload = (event: Event): void => event.preventDefault();
  contents.on("will-navigate", onNavigate);
  contents.on("will-redirect", onRedirect);
  contents.on("before-input-event", onInput);
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  contents.session.on("will-download", onDownload);
  return () => {
    contents.removeListener("will-navigate", onNavigate);
    contents.removeListener("will-redirect", onRedirect);
    contents.removeListener("before-input-event", onInput);
    contents.session.removeListener("will-download", onDownload);
    contents.session.setPermissionRequestHandler(null);
  };
}
