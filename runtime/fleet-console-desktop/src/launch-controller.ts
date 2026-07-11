import type { EntryPageSnapshot, EntryPageWebContents } from "./entry-page.js";

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
}

export interface LaunchController {
  start(): Promise<LaunchWindow>;
}

const CHECKING_SNAPSHOT: EntryPageSnapshot = { platform: process.platform, foot: "console updates install automatically at launch", dev: false, steps: [{ name: "Runtime ready", sub: "managed runtime", state: "complete" }, { name: "Checking for updates", sub: "registry", state: "active" }, { name: "Starting console", sub: "waiting for runtime", state: "waiting" }] };

export function createLaunchController(dependencies: LaunchControllerDependencies): LaunchController {
  return {
    async start() {
      const window = await dependencies.createWindow();
      await dependencies.pushEntry(window.webContents, CHECKING_SNAPSHOT);
      window.show();
      const consoleUrl = await dependencies.startOrAdopt();
      dependencies.handoffOrigin(new URL(consoleUrl).origin);
      await dependencies.pushEntry(window.webContents, { ...CHECKING_SNAPSHOT, steps: CHECKING_SNAPSHOT.steps.map((step) => step.name === "Starting console" ? { ...step, state: "complete", result: "ready" } : step), handoff: "Console ready" });
      await window.loadURL(consoleUrl);
      return window;
    },
  };
}
