import type { CoreSettingsAPI } from "./types.js";

export interface SettingsRuntime {
  init(service: CoreSettingsAPI): void;
  reset(expectedService?: CoreSettingsAPI): void;
  get(): CoreSettingsAPI | null;
}

export function createSettingsRuntime(): SettingsRuntime {
  let serviceRef: CoreSettingsAPI | null = null;

  return {
    init(service) {
      serviceRef = service;
    },
    reset(expectedService) {
      if (expectedService && serviceRef !== expectedService) {
        return;
      }
      serviceRef = null;
    },
    get() {
      return serviceRef;
    },
  };
}

export const settingsRuntime = createSettingsRuntime();
