import { describe, expect, it, vi } from "vitest";

import { isConsoleConflict, isConsolePairingIdentityUnavailable, showConsoleConflictAndQuit, showConsolePairingIdentityUnavailableAndQuit } from "../src/console-conflict.js";

describe("Console conflict handling", () => {
  it.each(["console_lock_foreign_process_appeared", "console_lock_foreign_process_unhealthy"])("classifies %s as a live external Console conflict", (message) => {
    expect(isConsoleConflict(new Error(message))).toBe(true);
  });

  it.each([new Error("console_lock_malformed: invalid_json"), new Error("sidecar_spawn_failed: missing node"), new Error("console_runtime_unavailable"), new Error("console_lock_foreign_process_appeared: extra"), new Error("console_lock_process_unhealthy"), "console_lock_foreign_process_unhealthy", null])("does not classify unrelated bootstrap failures as conflicts", (error) => {
    expect(isConsoleConflict(error)).toBe(false);
  });

  it("classifies only healthy foreign pairing identity failures for native startup feedback", () => {
    expect(isConsolePairingIdentityUnavailable(new Error("console_pairing_identity_unavailable"))).toBe(true);
    expect(isConsolePairingIdentityUnavailable(new Error("pairing_target_identity_invalid"))).toBe(false);
    expect(isConsolePairingIdentityUnavailable(new Error("console_lock_foreign_process_unhealthy"))).toBe(false);
  });

  it("shows one acknowledgement explaining how to resolve the conflict, then quits", async () => {
    const order: string[] = [];
    const showMessageBox = vi.fn(async () => { order.push("dialog"); });
    const quit = vi.fn(() => { order.push("quit"); });

    await showConsoleConflictAndQuit({ showMessageBox, quit });

    expect(showMessageBox).toHaveBeenCalledOnce();
    expect(showMessageBox).toHaveBeenCalledWith({
      type: "warning",
      title: "Fleet Console is already running",
      message: "Fleet Console is already running.",
      detail: "Stop or quit the running Fleet Console before opening Fleet Console Desktop again.",
      buttons: ["OK"],
      defaultId: 0,
      cancelId: 0,
    });
    expect(order).toEqual(["dialog", "quit"]);
  });

  it("quits even when Electron cannot show the acknowledgement dialog", async () => {
    const quit = vi.fn();

    await expect(showConsoleConflictAndQuit({ showMessageBox: vi.fn(async () => { throw new Error("dialog unavailable"); }), quit })).resolves.toBeUndefined();

    expect(quit).toHaveBeenCalledOnce();
  });

  it("shows identity verification feedback while leaving the foreign Console untouched", async () => {
    const showMessageBox = vi.fn(async () => {});
    const quit = vi.fn();

    await showConsolePairingIdentityUnavailableAndQuit({ showMessageBox, quit });

    expect(showMessageBox).toHaveBeenCalledWith({
      type: "error",
      title: "Could not connect to Fleet Console",
      message: "The running Fleet Console could not be verified.",
      detail: "Its pairing identity is unavailable or incompatible. Fleet Console Desktop left the running Console unchanged.",
      buttons: ["OK"],
      defaultId: 0,
      cancelId: 0,
    });
    expect(quit).toHaveBeenCalledOnce();
  });
});
