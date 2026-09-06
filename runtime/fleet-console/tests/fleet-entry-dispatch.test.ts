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
