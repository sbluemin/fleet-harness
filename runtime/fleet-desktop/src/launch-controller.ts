import type { EntryPageSnapshot, EntryPageWebContents } from "./entry-page.js";

export type RuntimeEntryState = "choosing" | "checking" | "node" | "installing" | "offline" | "firstfail" | "starting" | "dev";

/**
 * 시작할 때 어떤 콘솔에 붙을지는 물어서 정하고, 그 답은 기억하지 않는다. 런타임은 물려받는
 * 것이 아니라 고르는 것이다 — 어제의 선택이 오늘 조용히 원격에 붙는 일이 없어야 한다.
 */
export type StartupChoice =
  | { readonly kind: "local" }
  | { readonly kind: "target"; readonly value: string }
  | { readonly kind: "cancelled" };

export interface LaunchWindow {
  isDestroyed?(): boolean;
  loadURL(url: string): Promise<void>;
  show(): void;
  webContents: EntryPageWebContents & { navigationHistory: { clear(): void } };
}

export interface LaunchControllerDependencies {
  readonly createWindow: () => Promise<LaunchWindow>;
  readonly handoffOrigin: (origin: string) => void;
  readonly synchronizeTheme?: (origin: string) => Promise<void>;
  readonly synchronizeFullscreen?: (origin: string) => void | Promise<void>;
  readonly onConsoleLoaded?: () => void;
  readonly pushEntry: (contents: EntryPageWebContents, snapshot: EntryPageSnapshot) => Promise<void>;
  readonly startOrAdopt: () => Promise<string>;
  readonly dev?: boolean;
  readonly onFirstRunFailure?: () => Promise<boolean>;
  readonly onWindowReady?: (push: (state: RuntimeEntryState, detail?: string, progress?: number) => Promise<void>) => void;
  readonly chooseRuntime?: (window: LaunchWindow) => Promise<StartupChoice>;
  /** 고른 대상에 실제로 붙는다. 성공 여부만 돌려주고, 사용자 안내는 호출자가 이미 했다. */
  readonly connectTarget?: (value: string, window: LaunchWindow) => Promise<boolean>;
  readonly onStartupCancelled?: () => void;
}

export interface LaunchController { start(): Promise<LaunchWindow>; }

const FOOT = "console updates install automatically at launch";

export function createLaunchController(dependencies: LaunchControllerDependencies): LaunchController {
  return {
    async start() {
      const window = await dependencies.createWindow();
      const push = async (state: RuntimeEntryState, detail?: string, progress?: number): Promise<void> => {
        if (window.isDestroyed?.()) return;
        await dependencies.pushEntry(window.webContents, snapshotFor(state, dependencies.dev ?? false, detail, progress));
      };
      // 창을 보이기 전에 먼저 칠한다 — 빈 창이 한 프레임이라도 보이면 안 된다.
      await push(dependencies.chooseRuntime ? "choosing" : dependencies.dev ? "dev" : "checking");
      dependencies.onWindowReady?.(push);
      window.show();
      if (dependencies.chooseRuntime) {
        while (true) {
          if (window.isDestroyed?.()) return window;
          const choice = await dependencies.chooseRuntime(window);
          if (choice.kind === "cancelled") {
            dependencies.onStartupCancelled?.();
            return window;
          }
          if (choice.kind === "local") break;
          // 부팅에는 돌아갈 콘솔이 없다 — 실패하면 죽은 엔트리 화면을 남기지 않고 다시 묻는다.
          if (await dependencies.connectTarget?.(choice.value, window)) return window;
          if (window.isDestroyed?.()) return window;
          await push("choosing");
        }
        await push(dependencies.dev ? "dev" : "checking");
      }
      let consoleUrl: string;
      while (true) {
        try {
          consoleUrl = await dependencies.startOrAdopt();
          break;
        } catch (error) {
          if (!isFirstRunProcurementFailure(error)) throw error;
          await push("firstfail", error.message);
          if (!dependencies.onFirstRunFailure || !await dependencies.onFirstRunFailure()) throw error;
        }
      }
      if (window.isDestroyed?.()) return window;
      const origin = new URL(consoleUrl).origin;
      dependencies.handoffOrigin(origin);
      await dependencies.synchronizeTheme?.(origin);
      await push("starting", "ready");
      if (!window.isDestroyed?.()) {
        await window.loadURL(consoleUrl);
        if (!window.isDestroyed?.()) window.webContents.navigationHistory.clear();
      }
      if (!window.isDestroyed?.()) await dependencies.synchronizeFullscreen?.(origin);
      if (!window.isDestroyed?.()) dependencies.onConsoleLoaded?.();
      return window;
    },
  };
}

function isFirstRunProcurementFailure(error: unknown): error is Error {
  return error instanceof Error && error.message === "console_runtime_unavailable";
}

function snapshotFor(state: RuntimeEntryState, dev: boolean, detail?: string, progress?: number): EntryPageSnapshot {
  const base = { platform: process.platform, foot: FOOT, dev };
  if (state === "choosing") return { ...base, steps: [{ name: "Waiting for a runtime choice", sub: "managed local, loopback address, or access link", state: "active" }] };
  if (state === "dev") return { ...base, steps: [{ name: "Local build", sub: "LOCAL BUILD · DEV", state: "complete", result: "update skipped" }, { name: "Starting console", sub: "local channel", state: "active" }] };
  if (state === "node") return { ...base, steps: [{ name: "Downloading Node runtime", sub: detail ?? "checksum verified", state: "active", progress }, { name: "Installing Fleet Console", sub: "waiting", state: "waiting" }] };
  if (state === "installing") return { ...base, steps: [{ name: "Runtime ready", sub: "managed runtime", state: "complete" }, { name: "Installing Fleet Console", sub: detail ?? "registry", state: "active", progress }, { name: "Starting console", sub: "waiting for runtime", state: "waiting" }] };
  if (state === "offline") return { ...base, steps: [{ name: "Checking for updates", sub: "registry", state: "warning", result: detail ?? "unreachable — installed latest" }, { name: "Starting console", sub: "installed latest", state: "active" }] };
  if (state === "firstfail") return { ...base, steps: [{ name: "Installing Fleet Console", sub: "registry", state: "failed", result: detail ?? "failed — unreachable" }] };
  if (state === "starting") return { ...base, steps: [{ name: "Runtime ready", sub: "managed runtime", state: "complete" }, { name: "Checking for updates", sub: "up to date", state: "complete" }, { name: "Starting console", sub: detail ?? "waiting for runtime", state: detail === "ready" ? "complete" : "active", result: detail === "ready" ? "ready" : undefined }], handoff: detail === "ready" ? "Console ready" : undefined };
  return { ...base, steps: [{ name: "Runtime ready", sub: "managed runtime", state: "complete" }, { name: "Checking for updates", sub: "registry", state: "active" }, { name: "Starting console", sub: "waiting for runtime", state: "waiting" }] };
}
