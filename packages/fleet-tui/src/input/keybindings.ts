export const HOST_EXIT_KEY = "\x11";
export const HOST_INTERRUPT_KEY = "\x03";
export const MODE_TOGGLE_KEY = "\x14";
export const CARRIER_STATUS_KEY = "\x1bo";

export type InputAction = string;

export interface KeybindingRegistration {
  readonly action: InputAction;
  readonly key: string;
  readonly handler: () => void;
}

const registrations = new Map<InputAction, KeybindingRegistration>();

export function isHostExit(data: string): boolean {
  return data === HOST_EXIT_KEY || data === HOST_INTERRUPT_KEY;
}

export function isModeToggle(data: string): boolean {
  return data === MODE_TOGGLE_KEY;
}

export function isKeyRelease(data: string): boolean {
  return data === "";
}

export function registerKeybinding(registration: KeybindingRegistration): void {
  registrations.set(registration.action, registration);
}

export function dispatchRegisteredKeybinding(data: string): boolean {
  for (const registration of registrations.values()) {
    if (data === registration.key) {
      registration.handler();
      return true;
    }
  }

  return false;
}

export function getRegisteredKeybindings(): KeybindingRegistration[] {
  return [...registrations.values()];
}
