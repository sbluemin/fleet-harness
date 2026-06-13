import type { InputKeybindingConfig } from "./keybindings.js";

export function assertInputContract(keybindings: InputKeybindingConfig): void {
  assertNoDuplicateKeybindings(keybindings);
}

export function isKeyRelease(data: string): boolean {
  return data === "";
}

function assertNoDuplicateKeybindings(keybindings: InputKeybindingConfig): void {
  const keys = [
    ...keybindings.registeredKeybindings.map((binding) => binding.key),
  ];
  if (new Set(keys).size !== keys.length) {
    throw new Error("Dedicated Harness input keybindings must not conflict");
  }
}
