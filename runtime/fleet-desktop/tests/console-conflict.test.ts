import { describe, expect, it, vi } from "vitest";

import { describeConsoleLockRecoverDialog, describeConsoleLockRecoverRefusedDialog, isConsoleConflict, showConsoleConflictAndQuit, type ConsoleConflictDialogOptions } from "../src/boot-dialogs.js";
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

  it("offers to clear a stuck lock with matching language, no manual delete guidance, and specific refusal messages", () => {
    const unverified = new SidecarLockConflictError("console_lock_process_unverified", { pid: 4242, lockFile: LOCK_FILE, observed: "unverified", reason: "it did not prove it is the Console" });
    const offeredKo = describeConsoleLockRecoverDialog(unverified, "/fleet/logs", "ko");
    expect(offeredKo?.buttons).toEqual(["잠금 정리 후 다시 시작", "취소"]);
    expect(offeredKo?.cancelId).toBe(1);
    expect(offeredKo?.defaultId).toBe(1);
    expect(offeredKo?.title).toBe("Fleet Console 잠금이 사용 중입니다");
    expect(offeredKo?.message).toMatch(/[가-힣]/);
    expect(offeredKo?.detail).toContain("4242");
    expect(offeredKo?.detail).toContain(LOCK_FILE);
    expect(offeredKo?.detail).toContain("/fleet/logs");
    expect(offeredKo?.detail).not.toMatch(/delete|ps -A|left untouched/i);
    expect(JSON.stringify(offeredKo)).not.toContain(TOKEN);

    const ownerlessKo = describeConsoleLockRecoverDialog(new Error("console_lock_ownerless"), "/fleet/logs", "ko");
    expect(ownerlessKo?.title).toBe("Fleet Console을 시작할 수 없습니다");
    expect(ownerlessKo?.message).toMatch(/[가-힣]/);
    expect(ownerlessKo?.detail).not.toMatch(/delete|ps -A|left untouched/i);

    const ownerlessEn = describeConsoleLockRecoverDialog(new Error("console_lock_ownerless"), "/fleet/logs", "en");
    expect(ownerlessEn?.buttons).toEqual(["Clear the lock and start again", "Cancel"]);
    expect(ownerlessEn?.detail).not.toMatch(/delete .* and start again|ps -A/i);

    const stopping = new SidecarLockConflictError("console_lock_process_unverified", { pid: 4242, lockFile: LOCK_FILE, observed: "stopping", reason: "it is shutting down" });
    expect(describeConsoleLockRecoverDialog(stopping)).toBeNull();
    expect(describeConsoleLockRecoverDialog(new Error("console_lock_refused"))).toBeNull();

    const symlinkRefused = describeConsoleLockRecoverRefusedDialog({ code: "symlink", reason: "Refusing /fleet/console.lock: it is a symbolic link." }, "ko", LOCK_FILE);
    const changedRefused = describeConsoleLockRecoverRefusedDialog({ code: "lock_changed", reason: "the lock changed while recovery was checking it" }, "ko", LOCK_FILE);
    const liveRefused = describeConsoleLockRecoverRefusedDialog({ code: "live_console", reason: "pid 4242 is still running" }, "ko", LOCK_FILE);
    const foreignRefused = describeConsoleLockRecoverRefusedDialog({ code: "foreign_owner", reason: "owned by uid 0" }, "ko", LOCK_FILE);
    expect(symlinkRefused.message).toContain("심볼릭 링크");
    expect(changedRefused.message).toContain("바뀌어");
    expect(liveRefused.message).toContain("실행 중인 Console");
    expect(liveRefused.detail).toContain("실행 중인 Fleet Console을 종료한 뒤 다시 시작하세요.");
    expect(foreignRefused.message).toContain("다른 사용자");
    for (const refused of [symlinkRefused, changedRefused, liveRefused, foreignRefused]) {
      expect(refused.detail).toMatch(/[가-힣]/);
      expect(refused.detail).toContain(LOCK_FILE);
      expect(refused.detail).not.toMatch(/Refusing|still running|while recovery|owned by/i);
    }
    expect(new Set([symlinkRefused.message, changedRefused.message, liveRefused.message, foreignRefused.message]).size).toBe(4);
    expect(symlinkRefused.buttons).toEqual(["확인"]);
    const symlinkRefusedEn = describeConsoleLockRecoverRefusedDialog({ code: "symlink", reason: "Refusing /fleet/console.lock: it is a symbolic link." }, "en", LOCK_FILE);
    expect(symlinkRefusedEn.detail).toBe("Refusing /fleet/console.lock: it is a symbolic link.");
  });

  it("quits even when Electron cannot show the acknowledgement dialog", async () => {
    const quit = vi.fn();

    await expect(showConsoleConflictAndQuit(new Error("console_lock_process_unverified"), { showMessageBox: vi.fn(async () => { throw new Error("dialog unavailable"); }), quit })).resolves.toBeUndefined();

    expect(quit).toHaveBeenCalledOnce();
  });
});
