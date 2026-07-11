import type { EntryPageSnapshot, EntryPageWebContents } from "./entry-page.js";

export type RuntimeEntryState = "checking" | "node" | "installing" | "offline" | "firstfail" | "starting" | "dev";

export interface LaunchWindow {
  loadURL(url: string): Promise<void>;
  show(): void;
  webContents: EntryPageWebContents;
}

export interface LaunchControllerDependencies {
  readonly createWindow: () => Promise<LaunchWindow>;
  readonly handoffOrigin: (origin: string) => void;
  readonly pushEntry: (contents: EntryPageWebContents, snapshot: EntryPageSnapshot) => Promise<void>;
  readonly startOrAdopt: () => Promise<string>;
  readonly dev?: boolean;
  readonly onFirstRunFailure?: () => Promise<boolean>;
  readonly onWindowReady?: (push: (state: RuntimeEntryState, detail?: string, progress?: number) => Promise<void>) => void;
}

export interface LaunchController { start(): Promise<LaunchWindow>; }

const FOOT = "console updates install automatically at launch";

export function createLaunchController(dependencies: LaunchControllerDependencies): LaunchController {
  return {
    async start() {
      const window = await dependencies.createWindow();
      const push = async (state: RuntimeEntryState, detail?: string, progress?: number): Promise<void> => {
        await dependencies.pushEntry(window.webContents, snapshotFor(state, dependencies.dev ?? false, detail, progress));
      };
      await push(dependencies.dev ? "dev" : "checking");
      dependencies.onWindowReady?.(push);
      window.show();
      let consoleUrl: string;
      try {
        consoleUrl = await dependencies.startOrAdopt();
      } catch (error) {
        await push("firstfail", error instanceof Error ? error.message : String(error));
        if (!dependencies.onFirstRunFailure || !await dependencies.onFirstRunFailure()) throw error;
        consoleUrl = await dependencies.startOrAdopt();
      }
      dependencies.handoffOrigin(new URL(consoleUrl).origin);
      await push("starting", "ready");
      await window.loadURL(consoleUrl);
      return window;
    },
  };
}

function snapshotFor(state: RuntimeEntryState, dev: boolean, detail?: string, progress?: number): EntryPageSnapshot {
  const base = { platform: process.platform, foot: FOOT, dev };
  if (state === "dev") return { ...base, steps: [{ name: "Local build", sub: "LOCAL BUILD · DEV", state: "complete", result: "update skipped" }, { name: "Starting console", sub: "local channel", state: "active" }] };
  if (state === "node") return { ...base, steps: [{ name: "Downloading Node runtime", sub: detail ?? "checksum verified", state: "active", progress }, { name: "Installing Fleet Console", sub: "waiting", state: "waiting" }] };
  if (state === "installing") return { ...base, steps: [{ name: "Runtime ready", sub: "managed runtime", state: "complete" }, { name: "Installing Fleet Console", sub: detail ?? "registry", state: "active", progress }, { name: "Starting console", sub: "waiting for runtime", state: "waiting" }] };
  if (state === "offline") return { ...base, steps: [{ name: "Checking for updates", sub: "registry", state: "warning", result: detail ?? "unreachable — installed latest" }, { name: "Starting console", sub: "installed latest", state: "active" }] };
  if (state === "firstfail") return { ...base, steps: [{ name: "Installing Fleet Console", sub: "registry", state: "failed", result: detail ?? "failed — unreachable" }] };
  if (state === "starting") return { ...base, steps: [{ name: "Runtime ready", sub: "managed runtime", state: "complete" }, { name: "Checking for updates", sub: "up to date", state: "complete" }, { name: "Starting console", sub: detail ?? "waiting for runtime", state: detail === "ready" ? "complete" : "active", result: detail === "ready" ? "ready" : undefined }], handoff: detail === "ready" ? "Console ready" : undefined };
  return { ...base, steps: [{ name: "Runtime ready", sub: "managed runtime", state: "complete" }, { name: "Checking for updates", sub: "registry", state: "active" }, { name: "Starting console", sub: "waiting for runtime", state: "waiting" }] };
}
