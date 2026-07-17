import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BrowserWindow, BrowserWindowConstructorOptions, Event, WebContents } from "electron";

export const PAIRING_SCHEME = "fleet-desktop-pairing:";
const PAIRING_PARTITION = "fleet-desktop-pairing";

export interface PairingModal {
  prompt(parent: BrowserWindow, rememberedTarget?: string | null): Promise<string | null>;
}

export interface PairingModalDependencies {
  readonly BrowserWindow: typeof BrowserWindow;
  readonly pairingPagePath: string;
  readonly fileSystem?: PairingTemplateFileSystem;
  readonly temporaryDirectory?: string;
}

interface PairingModalWindow extends BrowserWindow {
  readonly webContents: WebContents;
}

interface PairingTemplateFileSystem {
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, data: string, options: { readonly encoding: "utf8"; readonly mode: number; readonly flag: "wx" }): void;
  mkdtempSync(prefix: string): string;
  copyFileSync(source: string, destination: string): void;
  chmodSync(path: string, mode: number): void;
  rmSync(path: string, options: { readonly recursive: true; readonly force: true }): void;
}

// 이 모달은 렌더러 코드 없이 폼 이동만 받아, 사용자 입력이 IPC나 실행 문자열을 통과하지 않게 한다.
export function createPairingModal(dependencies: PairingModalDependencies): PairingModal {
  const fileSystem = dependencies.fileSystem ?? fs;
  const temporaryDirectory = dependencies.temporaryDirectory ?? os.tmpdir();
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
      let temporaryPageDirectory: string | null = null;
      let temporaryPagePath: string | null = null;
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
        if (temporaryPageDirectory) {
          try { fileSystem.rmSync(temporaryPageDirectory, { recursive: true, force: true }); } catch { /* Best-effort cleanup preserves modal completion. */ }
          temporaryPageDirectory = null;
          temporaryPagePath = null;
        }
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
      const temporaryPage = createRememberedPairingPage(dependencies.pairingPagePath, rememberedTarget, fileSystem, temporaryDirectory);
      temporaryPageDirectory = temporaryPage?.directory ?? null;
      temporaryPagePath = temporaryPage?.path ?? null;
      void modal.loadFile(temporaryPagePath ?? dependencies.pairingPagePath).catch(() => finish(null));
      return result;
    },
  };
}

function rememberedSshHost(target: string | null): string | null {
  return target?.startsWith("ssh:") && target.length > 4 ? target.slice(4) : null;
}

function createRememberedPairingPage(pairingPagePath: string, target: string | null, fileSystem: PairingTemplateFileSystem, temporaryDirectory: string): { readonly directory: string; readonly path: string } | null {
  const host = rememberedSshHost(target);
  if (!host) return null;
  let directory: string | null = null;
  try {
    directory = fileSystem.mkdtempSync(path.join(temporaryDirectory, "fleet-desktop-pairing-"));
    const html = withRememberedSshTarget(fileSystem.readFileSync(pairingPagePath, "utf8"), host);
    const temporaryPath = path.join(directory, "index.html");
    fileSystem.writeFileSync(temporaryPath, html, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const stylesheetPath = path.join(directory, "pairing.css");
    fileSystem.copyFileSync(path.join(path.dirname(pairingPagePath), "pairing.css"), stylesheetPath);
    fileSystem.chmodSync(stylesheetPath, 0o600);
    return { directory, path: temporaryPath };
  } catch {
    if (directory) {
      try { fileSystem.rmSync(directory, { recursive: true, force: true }); } catch { /* Best-effort cleanup preserves static fallback. */ }
    }
    return null;
  }
}

function withRememberedSshTarget(html: string, host: string): string {
  return addAttribute(addAttribute(html, "mode-ssh", "checked"), "ssh-host", `value="${escapeHtmlAttribute(host)}"`);
}

function addAttribute(html: string, id: string, attribute: string): string {
  const expression = new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`, "u");
  const match = html.match(expression);
  if (!match) throw new Error("pairing_template_marker_missing");
  return html.replace(expression, `${match[0]!.slice(0, -1)} ${attribute}>`);
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[character] ?? character);
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
