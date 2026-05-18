export const HOST_EXIT_KEY = "\x11";
export const HOST_INTERRUPT_KEY = "\x03";
export const MODE_TOGGLE_KEY = "\x14";

export function isHostExit(data: string): boolean {
  return data === HOST_EXIT_KEY || data === HOST_INTERRUPT_KEY;
}

export function isModeToggle(data: string): boolean {
  return data === MODE_TOGGLE_KEY;
}

export function isKeyRelease(data: string): boolean {
  return data === "";
}

