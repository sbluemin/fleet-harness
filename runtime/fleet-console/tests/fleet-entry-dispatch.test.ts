import { describe, expect, it, vi } from "vitest";

import { classifyFleetArgv, dispatchFleetArgv } from "../cli/fleet-dispatch.js";

function createIo() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write(chunk: string) {
        stdout += chunk;
        return true;
      },
      isTTY: false as boolean | undefined,
      toString() {
        return stdout;
      },
    },
    stderr: {
      write(chunk: string) {
        stderr += chunk;
        return true;
      },
      toString() {
        return stderr;
      },
    },
  };
}

describe("dual-entry dispatch", () => {
  it("runs Console help for fleet console --help without Claude passthrough", async () => {
    const io = createIo();
    const runApp = vi.fn(async () => undefined);
    const status = await dispatchFleetArgv(["console", "--help"], {
      stdout: io.stdout,
      stderr: io.stderr,
      env: {},
      runApp: runApp as never,
      createAuthService: (() => ({})) as never,
      dispatchAuthCommand: (async () => 0) as never,
      dispatchUpdateCommand: (async () => 0) as never,
    });
    expect(status).toBe(0);
    expect(io.stdout.toString()).toContain("fleet console");
    expect(io.stdout.toString()).toContain("fleet-console");
    expect(runApp).not.toHaveBeenCalled();
  });

  it("rejects unknown fleet console modes without Claude passthrough", async () => {
    const io = createIo();
    const runApp = vi.fn(async () => undefined);
    const status = await dispatchFleetArgv(["console", "unknown"], {
      stdout: io.stdout,
      stderr: io.stderr,
      env: {},
      runApp: runApp as never,
      createAuthService: (() => ({})) as never,
      dispatchAuthCommand: (async () => 0) as never,
      dispatchUpdateCommand: (async () => 0) as never,
    });
    expect(status).toBe(1);
    expect(io.stderr.toString()).toContain("Unknown fleet console command: unknown");
    expect(runApp).not.toHaveBeenCalled();
  });

  it("prints Fleet help for bare --help", async () => {
    const io = createIo();
    const runApp = vi.fn(async () => undefined);
    const status = await dispatchFleetArgv(["--help"], {
      stdout: io.stdout,
      stderr: io.stderr,
      env: {},
      runApp: runApp as never,
      createAuthService: (() => ({})) as never,
      dispatchAuthCommand: (async () => 0) as never,
      dispatchUpdateCommand: (async () => 0) as never,
    });
    expect(status).toBe(0);
    expect(io.stdout.toString()).toContain("fleet console");
    expect(io.stdout.toString()).toContain("Unrecognized arguments are passed through to Claude Code.");
    expect(runApp).not.toHaveBeenCalled();
  });

  it("strips fleet cli before help/passthrough", async () => {
    const io = createIo();
    const runApp = vi.fn(async () => undefined);
    const helpStatus = await dispatchFleetArgv(["cli", "--help"], {
      stdout: io.stdout,
      stderr: io.stderr,
      env: {},
      runApp: runApp as never,
      createAuthService: (() => ({})) as never,
      dispatchAuthCommand: (async () => 0) as never,
      dispatchUpdateCommand: (async () => 0) as never,
    });
    expect(helpStatus).toBe(0);
    expect(io.stdout.toString()).toContain("Unrecognized arguments are passed through to Claude Code.");
    expect(runApp).not.toHaveBeenCalled();

    const passthrough = await dispatchFleetArgv(["cli", "--model", "sonnet"], {
      stdout: io.stdout,
      stderr: io.stderr,
      env: {},
      runApp: runApp as never,
      createAuthService: (() => ({})) as never,
      dispatchAuthCommand: (async () => 0) as never,
      dispatchUpdateCommand: (async () => 0) as never,
    });
    expect(passthrough).toBe(0);
    expect(runApp).toHaveBeenCalledWith({ passthroughArgs: ["--model", "sonnet"] });
  });

  it("prints the Fleet package version without Claude passthrough", async () => {
    const io = createIo();
    const runApp = vi.fn(async () => undefined);
    for (const argv of [["--version"], ["-v"], ["version"]] as const) {
      io.stdout.write("");
      const status = await dispatchFleetArgv([...argv], {
        stdout: io.stdout,
        stderr: io.stderr,
        env: {},
        runApp: runApp as never,
        createAuthService: (() => ({})) as never,
        dispatchAuthCommand: (async () => 0) as never,
        dispatchUpdateCommand: (async () => 0) as never,
      });
      expect(status).toBe(0);
    }
    expect(io.stdout.toString()).toContain("@dotobokuri/fleet-console");
    expect(io.stdout.toString()).toContain("Claude Code version: fleet cli --version");
    expect(runApp).not.toHaveBeenCalled();
  });

  it("aliases fleet status to console status without Claude passthrough", async () => {
    expect(classifyFleetArgv(["status"])).toEqual({ kind: "console", consoleArgv: ["status"] });
    expect(classifyFleetArgv(["status", "--help"])).toEqual({ kind: "console", consoleArgv: ["status", "--help"] });
    expect(classifyFleetArgv(["cli", "status"])).toEqual({
      kind: "passthrough",
      passthroughArgs: ["status"],
    });
  });

  it("reserves fleet gateway and keeps it off the Claude passthrough path", async () => {
    expect(classifyFleetArgv(["gateway"])).toEqual({ kind: "gateway", gatewayArgv: [] });
    expect(classifyFleetArgv(["gateway", "set", "wire-log", "on"])).toEqual({
      kind: "gateway",
      gatewayArgv: ["set", "wire-log", "on"],
    });
    // `cli` 뒤의 예약어는 지금처럼 Claude에게 간다.
    expect(classifyFleetArgv(["cli", "gateway"])).toEqual({
      kind: "passthrough",
      passthroughArgs: ["gateway"],
    });
  });

  it("routes fleet gateway to the gateway dispatcher, not to Claude", async () => {
    const io = createIo();
    const runApp = vi.fn(async () => undefined);
    const gateway = vi.fn(async () => 0);
    const status = await dispatchFleetArgv(["gateway", "status"], {
      stdout: io.stdout,
      stderr: io.stderr,
      env: {},
      runApp: runApp as never,
      createAuthService: (() => ({})) as never,
      dispatchAuthCommand: (async () => 0) as never,
      dispatchUpdateCommand: (async () => 0) as never,
      dispatchGatewayCommand: gateway as never,
    });
    expect(status).toBe(0);
    expect(gateway).toHaveBeenCalledWith(["status"], io);
    expect(runApp).not.toHaveBeenCalled();
  });

  it("keeps fleet auth working but says where it moved", async () => {
    const io = createIo();
    const auth = vi.fn(async () => 0);
    const status = await dispatchFleetArgv(["auth", "list"], {
      stdout: io.stdout,
      stderr: io.stderr,
      env: {},
      runApp: (async () => undefined) as never,
      createAuthService: (() => ({})) as never,
      dispatchAuthCommand: auth as never,
      dispatchUpdateCommand: (async () => 0) as never,
    });
    expect(status).toBe(0);
    expect(auth).toHaveBeenCalledTimes(1);
    expect(io.stderr.toString()).toContain("`fleet auth` moved to `fleet gateway auth`");
  });

  it("reserves fleet doctor without Claude passthrough", async () => {
    expect(classifyFleetArgv(["doctor"])).toEqual({ kind: "doctor", argv: ["doctor"] });
    expect(classifyFleetArgv(["cli", "doctor"])).toEqual({
      kind: "passthrough",
      passthroughArgs: ["doctor"],
    });
  });

  it("keeps fleet cli --version as Claude passthrough", async () => {
    expect(classifyFleetArgv(["cli", "--version"])).toEqual({
      kind: "passthrough",
      passthroughArgs: ["--version"],
    });
    const io = createIo();
    const runApp = vi.fn(async () => undefined);
    const status = await dispatchFleetArgv(["cli", "--version"], {
      stdout: io.stdout,
      stderr: io.stderr,
      env: {},
      runApp: runApp as never,
      createAuthService: (() => ({})) as never,
      dispatchAuthCommand: (async () => 0) as never,
      dispatchUpdateCommand: (async () => 0) as never,
    });
    expect(status).toBe(0);
    expect(runApp).toHaveBeenCalledWith({ passthroughArgs: ["--version"] });
  });

  it("keeps entry isolation: fleet entry never imports the direct-run-guarded Console entry", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const source = fs.readFileSync(path.join(packageRoot, "cli", "fleet-entry.ts"), "utf8");
    expect(source).toContain("./fleet-dispatch.js");
    expect(source).not.toContain("../core/host/cli.js");
    expect(source).not.toContain("basename");
    expect(source).toContain("process.exitCode = status");
    expect(source).not.toContain("process.exit(status)");
  });
});
