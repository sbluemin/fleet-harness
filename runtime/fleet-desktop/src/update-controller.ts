import type { RegistryChecker } from "./runtime/registry-check.js";

export interface UpdateDialogResult { readonly response: number; readonly checkboxChecked: boolean; }

export interface UpdateControllerOptions {
  readonly currentVersion: () => string;
  readonly registry: RegistryChecker;
  readonly showDialog: (version: string) => Promise<UpdateDialogResult>;
  readonly prepareToQuit: () => Promise<void>;
  readonly relaunch: () => void;
  readonly quit: () => void;
  readonly onStateChange?: () => void;
}

export interface UpdateController {
  check(manual?: boolean): Promise<void>;
  install(): Promise<void>;
  /**
   * 콘솔 안에서 사용자가 이미 업데이트를 눌렀다. 동의는 그 자리에서 받았으므로 여기서
   * 다시 묻지 않는다 — 남은 일은 수행뿐이다. 네이티브 확인 대화를 거치는 check()와
   * 다른 점은 그것 하나다.
   */
  applyRequested(version: string): Promise<void>;
  availableVersion(): string | null;
  enabled(): boolean;
}

export interface WindowsUpdateWindow {
  isVisible(): boolean;
  show(): void;
}

export interface DestroyableWindow {
  isDestroyed(): boolean;
}

export function resolveActiveWindow<T extends DestroyableWindow>(window: T | null): T | null {
  return window && !window.isDestroyed() ? window : null;
}

export interface WindowsUpdateTray {
  displayBalloon(options: { readonly title: string; readonly content: string }): void;
  once(event: "balloon-click", callback: () => void): void;
}

export function createUpdateController(options: UpdateControllerOptions): UpdateController {
  let available: string | null = null;
  const install = async (): Promise<void> => {
    if (!available) return;
    await options.prepareToQuit();
    options.relaunch();
    options.quit();
  };
  return {
    async applyRequested(version: string) {
      available = version;
      options.onStateChange?.();
      await install();
    },
    async check(manual = true) {
      const result = await options.registry.check(options.currentVersion(), manual);
      available = result.latest === options.currentVersion() ? null : result.latest;
      options.onStateChange?.();
      if (!result.shouldNotify || !available) return;
      const dialog = await options.showDialog(available);
      if (dialog.checkboxChecked) await options.registry.skip(available);
      if (dialog.response === 0) await install();
    },
    install,
    availableVersion: () => available,
    enabled: () => true,
  };
}

export function createNoopUpdateController(): UpdateController {
  return { applyRequested: async () => undefined, check: async () => undefined, install: async () => undefined, availableVersion: () => null, enabled: () => false };
}

export async function showWindowsHiddenUpdateDialog(window: WindowsUpdateWindow | null, tray: WindowsUpdateTray | null, version: string, showDialog: () => Promise<UpdateDialogResult>): Promise<UpdateDialogResult> {
  if (window && tray && !window.isVisible()) {
    tray.displayBalloon({ title: "Update available", content: `Fleet Console ${version} is ready to install.` });
    await new Promise<void>((resolve) => tray.once("balloon-click", () => { window.show(); resolve(); }));
  }
  return showDialog();
}
