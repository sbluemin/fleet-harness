import { describe, expect, it, vi } from "vitest";

import { isConsoleConflict, showConsoleConflictAndQuit } from "../src/console-conflict.js";

describe("Console conflict handling", () => {
  it.each(["cli_daemon_requires_confirmation", "console_lock_process_unhealthy"])("classifies %s as a live external Console conflict", (message) => {
    expect(isConsoleConflict(new Error(message))).toBe(true);
  });

  it.each([new Error("console_lock_malformed: invalid_json"), new Error("sidecar_spawn_failed: missing node"), new Error("console_runtime_unavailable"), new Error("cli_daemon_requires_confirmation: extra"), "console_lock_process_unhealthy", null])("does not classify unrelated bootstrap failures as conflicts", (error) => {
    expect(isConsoleConflict(error)).toBe(false);
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
});
