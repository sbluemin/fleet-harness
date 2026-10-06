import { describe, expect, it, vi } from "vitest";

import { isConsoleConflict, showConsoleConflictAndQuit, type ConsoleConflictDialogOptions } from "../src/boot-dialogs.js";
import { SidecarLockConflictError } from "../src/sidecar-supervisor.js";

const LOCK_FILE = "/fleet/console/runtime/console.lock";
const TOKEN = "lock-token-that-must-stay-private";

async function shownDialog(error: unknown): Promise<{ readonly options: ConsoleConflictDialogOptions; readonly quit: ReturnType<typeof vi.fn> }> {
  const showMessageBox = vi.fn(async (_options: ConsoleConflictDialogOptions) => undefined);
  const quit = vi.fn();
  await showConsoleConflictAndQuit(error, { showMessageBox, quit, logDirectory: "/fleet/logs" });
  expect(showMessageBox).toHaveBeenCalledOnce();
  expect(quit).toHaveBeenCalledOnce();
  return { options: showMessageBox.mock.calls[0]![0], quit };
}

describe("Console conflict handling", () => {
  it.each(["cli_daemon_requires_confirmation", "console_lock_foreign_process_unhealthy", "console_lock_process_unverified", "console_lock_process_unhealthy"])("classifies %s as a Console conflict", (message) => {
    expect(isConsoleConflict(new Error(message))).toBe(true);
  });

  it.each([new Error("console_lock_malformed: invalid_json"), new Error("sidecar_spawn_failed: missing node"), new Error("console_runtime_unavailable"), new Error("cli_daemon_requires_confirmation: extra"), "console_lock_foreign_process_unhealthy", null])("does not classify unrelated bootstrap failures as conflicts", (error) => {
    expect(isConsoleConflict(error)).toBe(false);
  });

  it("names the lock holder in the dialog and never shows the lock token", async () => {
    const error = new SidecarLockConflictError("console_lock_process_unverified", { pid: 4242, lockFile: LOCK_FILE, observed: "unverified", reason: "it did not prove it is the Console" });
    // The supervisor keeps lock payloads nearby; nothing beyond the four diagnostic fields may reach the dialog.
    Object.assign(error, { lock: { pid: 4242, token: TOKEN } });
    Object.assign(error.diagnostic, { token: TOKEN });

    const { options } = await shownDialog(error);

    expect(options.buttons).toEqual(["OK"]);
    expect(options.detail).toContain("4242");
    expect(options.detail).toContain(LOCK_FILE);
    expect(JSON.stringify(options)).not.toContain(TOKEN);
  });

  it("explains a Console that outlived SIGKILL with its pid and lock, not as a reinstall", async () => {
    const error = new SidecarLockConflictError("console_lock_process_unhealthy", { pid: 5151, lockFile: LOCK_FILE, observed: "stopping", reason: "it outlived SIGKILL" });

    const { options } = await shownDialog(error);

    expect(options.detail).toContain("5151");
    expect(options.detail).toContain(LOCK_FILE);
    expect(options.detail).not.toMatch(/reinstall/i);
  });

  it("still shows an acknowledgement when a conflict carries no diagnostic", async () => {
    const { options } = await shownDialog(new Error("cli_daemon_requires_confirmation"));

    expect(options.buttons).toEqual(["OK"]);
    expect(options.title.length).toBeGreaterThan(0);
    expect(options.detail).not.toContain("pid");
  });

  it("quits even when Electron cannot show the acknowledgement dialog", async () => {
    const quit = vi.fn();

    await expect(showConsoleConflictAndQuit(new Error("console_lock_process_unverified"), { showMessageBox: vi.fn(async () => { throw new Error("dialog unavailable"); }), quit })).resolves.toBeUndefined();

    expect(quit).toHaveBeenCalledOnce();
  });
});
