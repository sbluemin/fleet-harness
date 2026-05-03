import type { CoreSettingsAPI } from "./types.js";

let settingsService: CoreSettingsAPI | null = null;

export function initSettingsService(service: CoreSettingsAPI): void {
  settingsService = service;
}

export function resetSettingsService(expectedService?: CoreSettingsAPI): void {
  if (expectedService && settingsService !== expectedService) {
    return;
  }
  settingsService = null;
}

export function getSettingsService(): CoreSettingsAPI | null {
  return settingsService;
}
