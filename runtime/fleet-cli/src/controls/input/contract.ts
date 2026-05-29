import type { FleetInputMode } from "../types.js";
import type { InputKeybindingConfig } from "./keybindings.js";

export function assertInputContract(keybindings: InputKeybindingConfig): void {
  assertNoDuplicateKeybindings(keybindings);
}

export function isHostExit(data: string, keybindings: InputKeybindingConfig): boolean {
  return keybindings.exitKeys.has(data);
}

export function isKeyRelease(data: string): boolean {
  return data === "";
}

export function isModeToggle(data: string, keybindings: InputKeybindingConfig): boolean {
  return keybindings.modeToggleKeys.has(data);
}

export function toggleFleetInputMode(mode: FleetInputMode): FleetInputMode {
  return mode === "MIRROR" ? "DEDICATED" : "MIRROR";
}

function assertNoDuplicateKeybindings(keybindings: InputKeybindingConfig): void {
  const keys = [
    ...keybindings.exitKeys,
    ...keybindings.modeToggleKeys,
    ...keybindings.registeredKeybindings.map((binding) => binding.key),
  ];
  if (new Set(keys).size !== keys.length) {
    throw new Error("Dedicated Harness input keybindings must not conflict");
  }
}
