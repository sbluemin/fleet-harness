import { HOST_EXIT_KEY, HOST_INTERRUPT_KEY, MODE_TOGGLE_KEY } from "./keybindings.js";

export function assertInputContract(): void {
  assertNoDuplicateKeybindings();
}

function assertNoDuplicateKeybindings(): void {
  const keys = [HOST_EXIT_KEY, HOST_INTERRUPT_KEY, MODE_TOGGLE_KEY];
  if (new Set(keys).size !== keys.length) {
    throw new Error("Dedicated Harness input keybindings must not conflict");
  }
}

