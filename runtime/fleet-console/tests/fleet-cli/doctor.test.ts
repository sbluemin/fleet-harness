import { describe, expect, it, vi } from "vitest";

import { buildFleetDoctorText, dispatchDoctorCommand } from "../../cli/doctor.js";

describe("fleet doctor", () => {
  it("prints help and exits 0", async () => {
    const io = createIo();
    await expect(dispatchDoctorCommand(["doctor", "--help"], io, createDeps())).resolves.toBe(0);
    expect(io.stdout.output).toContain("fleet doctor");
    expect(io.stdout.output).toContain("Usage:");
  });

  it("rejects extra arguments without probing", async () => {
    const io = createIo();
    const deps = createDeps();
    await expect(dispatchDoctorCommand(["doctor", "fix"], io, deps)).resolves.toBe(1);
    expect(deps.authService.listProviderIds).not.toHaveBeenCalled();
    expect(io.stderr.output).toContain("Unknown fleet doctor command: fix");
  });

  it("reports package, data, PATH, auth, console, and lock without changing state", async () => {
    const text = await buildFleetDoctorText(createDeps());
    expect(text).toBe([
      "package   @dotobokuri/fleet-console 1.62.0 (local)",
      "data      /tmp/fleet-root",
      "binary    /usr/bin/claude 2.1.233",
      "kimi      signed in",
      "opencode  signed out",
      "console   running (pid 12)",
      "lock      /tmp/console.lock",
    ].join("\n"));
  });

  it("never prints raw --version stdout when no semver is present", async () => {
    const deps = createDeps();
    deps.runVersion = vi.fn(async () => "/Users/sbluemin/.local/bin/claude (dev)\n");
    const text = await buildFleetDoctorText(deps);
    expect(text).toContain("binary    /usr/bin/claude (version unknown)");
    expect(text).not.toContain("/Users/sbluemin");
  });

  it("keeps the rest of the report when console status cannot be read", async () => {
    const deps = createDeps();
    deps.readConsoleStatus = vi.fn(async () => {
      throw new Error("Refusing symbolic console lock: /tmp/console.lock");
    });
    const text = await buildFleetDoctorText(deps);
    expect(text).toContain("package   @dotobokuri/fleet-console 1.62.0 (local)");
    expect(text).toContain("binary    /usr/bin/claude 2.1.233");
    expect(text).toContain("console   unreadable (Refusing symbolic console lock: /tmp/console.lock)");
    expect(text).toContain("lock      /tmp/console.lock");
  });

  it("reports the Windows npm shim path while still probing through cmd.exe", async () => {
    const deps = createDeps();
    deps.resolveBinary = vi.fn(() => ({
      bin: "C:\\Windows\\System32\\cmd.exe",
      prefixArgs: ["/d", "/s", "/c", "call", "C:\\npm\\claude.cmd "],
    }));
    const text = await buildFleetDoctorText(deps);
    expect(text).toContain("binary    C:\\npm\\claude.cmd 2.1.233");
    expect(text).not.toContain("cmd.exe");
    expect(deps.runVersion).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", "call", "C:\\npm\\claude.cmd ", "--version"],
    );
  });
});

function createIo() {
  const stdout = { output: "", write(chunk: string) { stdout.output += chunk; return true; } };
  const stderr = { output: "", write(chunk: string) { stderr.output += chunk; return true; } };
  return { stdout, stderr };
}

function createDeps() {
  return {
    release: { version: "1.62.0", channel: "local" as const },
    authService: {
      listProviderIds: vi.fn(async () => ["Claude Code with Moonshot Kimi"]),
    },
    resolveBinary: vi.fn(() => ({ bin: "/usr/bin/claude", prefixArgs: [] })),
    runVersion: vi.fn(async () => "2.1.233 (Claude Code)\n"),
    readConsoleStatus: vi.fn(async () => "Fleet Console server: running (pid 12)\n  endpoint   http://127.0.0.1:9/"),
    dataDir: "/tmp/fleet-root",
    lockFile: "/tmp/console.lock",
  };
}
