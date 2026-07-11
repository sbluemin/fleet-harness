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
  check(): Promise<void>;
  install(): Promise<void>;
  availableVersion(): string | null;
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
    async check() {
      const result = await options.registry.check(options.currentVersion());
      available = result.latest === options.currentVersion() ? null : result.latest;
      options.onStateChange?.();
      if (!result.shouldNotify || !available) return;
      const dialog = await options.showDialog(available);
      if (dialog.checkboxChecked) await options.registry.skip(available);
      if (dialog.response === 0) await install();
    },
    install,
    availableVersion: () => available,
  };
}
