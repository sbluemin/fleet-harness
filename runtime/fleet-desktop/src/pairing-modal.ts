import type { BrowserWindow, BrowserWindowConstructorOptions, Event, WebContents } from "electron";

export const PAIRING_SCHEME = "fleet-desktop-pairing:";
/** 주소가 아닌 선택. Desktop이 스스로 조달·기동하는 로컬 콘솔을 가리킨다. */
export const LOCAL_RUNTIME_CHOICE = "local";
const PAIRING_PARTITION = "fleet-desktop-pairing";

export interface PairingModal {
  prompt(parent: BrowserWindow): Promise<string | null>;
}

export interface PairingModalDependencies {
  readonly BrowserWindow: typeof BrowserWindow;
  readonly pairingPagePath: string;
}

interface PairingModalWindow extends BrowserWindow {
  readonly webContents: WebContents;
}

/**
 * 모달은 부모의 메뉴 액셀러레이터를 무시한다 — 그러지 않으면 모달 위에서 누른 Cmd+R이
 * 뒤에 있는 Console을 다시 불러온다. 그런데 macOS는 편집 명령도 같은 메뉴 액셀러레이터로
 * 전달하므로, 무시하는 순간 입력란의 Cmd+V까지 죽는다. 액세스 링크는 손으로 옮겨 적을
 * 물건이 아니므로, 편집 명령만 이 표에서 되살린다.
 */
const PAIRING_EDIT_COMMANDS: Readonly<Record<string, (contents: WebContents) => void>> = {
  v: (contents) => contents.paste(),
  c: (contents) => contents.copy(),
  x: (contents) => contents.cut(),
  a: (contents) => contents.selectAll(),
  z: (contents) => contents.undo(),
};

// 이 모달은 렌더러 코드 없이 폼 이동만 받아, 사용자 입력이 IPC나 실행 문자열을 통과하지 않게 한다.
export function createPairingModal(dependencies: PairingModalDependencies): PairingModal {
  let active: { readonly window: PairingModalWindow; readonly result: Promise<string | null>; ready: boolean } | null = null;

  return {
    prompt(parent): Promise<string | null> {
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
      void modal.loadFile(dependencies.pairingPagePath).catch(() => finish(null));
      return result;
    },
  };
}

export function createPairingModalOptions(parent: BrowserWindow): BrowserWindowConstructorOptions {
  return {
    parent,
    modal: true,
    show: false,
    width: 460,
    height: 420,
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
    // 관리형 로컬은 주소가 아니라 선택이다 — 값 없는 모드 하나로만 표현한다.
    if (rawSearch === "?mode=local") return LOCAL_RUNTIME_CHOICE;
    const loopback = /^\?target=([^&#]*)$/u.exec(rawSearch) ?? /^\?mode=loopback&target=([^&#]*)$/u.exec(rawSearch);
    if (loopback) return decodeRawTarget(loopback[1]!);
    const accessLink = /^\?mode=link&link=([^&#]*)$/u.exec(rawSearch);
    if (!accessLink) return undefined;
    return decodeRawTarget(accessLink[1]!);
  } catch {
    return undefined;
  }
}

export function editCommandFor(input: Pick<Electron.Input, "key" | "control" | "meta" | "alt" | "shift">): ((contents: WebContents) => void) | null {
  // macOS는 Command, 나머지는 Control. 둘 중 정확히 하나만 눌린 조합만 편집 명령으로 본다.
  if (input.alt || input.control === input.meta) return null;
  const key = input.key.toLowerCase();
  if (key === "z" && input.shift) return (contents) => contents.redo();
  if (input.shift) return null;
  return PAIRING_EDIT_COMMANDS[key] ?? null;
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
    if (input.type !== "keyDown") return;
    if (input.key === "Escape") {
      event.preventDefault();
      finish(null);
      return;
    }
    const command = editCommandFor(input);
    if (!command) return;
    event.preventDefault();
    command(contents);
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
