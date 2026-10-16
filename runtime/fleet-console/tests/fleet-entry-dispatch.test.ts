import { describe, expect, it } from "vitest";

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

  it("reserves fleet gateway and treats a bare invocation as help", () => {
    expect(classifyFleetArgv(["gateway"])).toEqual({ kind: "gateway", gatewayArgv: [] });
    expect(classifyFleetArgv(["gateway", "set", "wire-log", "on"])).toEqual({
      kind: "gateway",
      gatewayArgv: ["set", "wire-log", "on"],
    });
    expect(classifyFleetArgv([])).toEqual({ kind: "help" });
    expect(classifyFleetArgv(["--help"])).toEqual({ kind: "help" });
    expect(classifyFleetArgv(["cli", "gateway"])).toEqual({ kind: "unknown", command: "cli" });
    expect(classifyFleetArgv(["--version"])).toEqual({ kind: "version" });
  });

  it("prints help for bare fleet and rejects a retired cli invocation", async () => {
    const helpIo = createIo();
    const helpStatus = await dispatchFleetArgv([], {
      stdout: helpIo.stdout,
      stderr: helpIo.stderr,
      env: {},
      dispatchUpdateCommand: (async () => 0) as never,
    });
    expect(helpStatus).toBe(0);
    expect(helpIo.stdout.toString()).toContain("console");
    expect(helpIo.stderr.toString()).toBe("");

    const io = createIo();
    const status = await dispatchFleetArgv(["cli", "--version"], {
      stdout: io.stdout,
      stderr: io.stderr,
      env: {},
      dispatchUpdateCommand: (async () => 0) as never,
    });
    expect(status).not.toBe(0);
    const stderr = io.stderr.toString();
    expect(stderr).toContain("Unknown fleet command: cli");
    expect(stderr).toContain("fleet --help");
    expect(io.stdout.toString()).toBe("");
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
