import { describe, expect, it } from "vitest";

import { createDefaultTerminalLaunchResolver } from "../src/terminal/launch.js";

const LOCAL_CLI_ENTRY = "/work/runtime/fleet-cli/dist/index.js";

const baseDeps = {
  cwd: "/work",
  env: {} as NodeJS.ProcessEnv,
  execPath: "/usr/bin/node",
  homedir: () => "/home/user",
};

describe("createDefaultTerminalLaunchResolver", () => {
  it("launches the local fleet-cli entry in --native terminal mode", () => {
    const resolve = createDefaultTerminalLaunchResolver({
      ...baseDeps,
      exists: (candidate) => candidate === LOCAL_CLI_ENTRY,
    });

    const spec = resolve("/work");

    expect(spec.bin).toBe("/usr/bin/node");
    expect(spec.args).toEqual([LOCAL_CLI_ENTRY, "--native"]);
    expect(spec.env.TERM).toBe("xterm-256color");
  });

  it("falls back to the fleet binary with --native when no local entry exists", () => {
    const resolve = createDefaultTerminalLaunchResolver({
      ...baseDeps,
      exists: () => false,
    });

    const spec = resolve("/work");

    expect(spec.bin).toBe("fleet");
    expect(spec.args).toEqual(["--native"]);
  });

  it("honors a FLEET_TERMINAL_CMD override verbatim without forcing --native", () => {
    const resolve = createDefaultTerminalLaunchResolver({
      ...baseDeps,
      env: { FLEET_TERMINAL_CMD: "bash -l" } as NodeJS.ProcessEnv,
      exists: () => false,
    });

    const spec = resolve("/work");

    expect(spec.bin).toBe("bash");
    expect(spec.args).toEqual(["-l"]);
  });
});
