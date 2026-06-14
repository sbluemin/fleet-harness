import { describe, expect, it } from "vitest";

import { createDefaultTerminalLaunchResolver } from "../src/terminal/launch.js";
import type { FleetConsoleRelease } from "../src/release.js";

const CONSOLE_PACKAGE_ROOT = "/work/runtime/fleet-console";
const LOCAL_CLI_ENTRY = "/work/runtime/fleet-cli/dist/index.js";
const LOCAL_RELEASE: FleetConsoleRelease = { channel: "local", version: "0.0.0", packageRoot: CONSOLE_PACKAGE_ROOT };
const STABLE_RELEASE: FleetConsoleRelease = { channel: "stable", version: "1.4.0", packageRoot: CONSOLE_PACKAGE_ROOT };

const baseDeps = {
  cwd: "/work",
  env: {} as NodeJS.ProcessEnv,
  execPath: "/usr/bin/node",
  homedir: () => "/home/user",
  release: LOCAL_RELEASE,
};

describe("createDefaultTerminalLaunchResolver", () => {
  it("launches the sibling fleet-cli build in --headless --native terminal mode on the local channel", () => {
    const resolve = createDefaultTerminalLaunchResolver({
      ...baseDeps,
      exists: (candidate) => candidate === LOCAL_CLI_ENTRY,
    });

    const spec = resolve("/work");

    expect(spec.bin).toBe("/usr/bin/node");
    expect(spec.args).toEqual([LOCAL_CLI_ENTRY, "--headless", "--native"]);
    expect(spec.env.TERM).toBe("xterm-256color");
  });

  it("resolves the sibling fleet-cli from the console package root regardless of the selected cwd (Theater)", () => {
    const resolve = createDefaultTerminalLaunchResolver({
      ...baseDeps,
      exists: (candidate) => candidate === LOCAL_CLI_ENTRY,
    });

    // Theater(선택한 작업 디렉터리)가 모노레포 밖이어도 콘솔 패키지 루트 기준으로 형제 fleet-cli를 찾는다.
    const spec = resolve("/some/unrelated/project");

    expect(spec.bin).toBe("/usr/bin/node");
    expect(spec.args).toEqual([LOCAL_CLI_ENTRY, "--headless", "--native"]);
  });

  it("uses the global fleet binary with --headless --native on the stable channel", () => {
    const resolve = createDefaultTerminalLaunchResolver({
      ...baseDeps,
      release: STABLE_RELEASE,
      exists: () => false,
    });

    const spec = resolve("/work");

    expect(spec.bin).toBe("fleet");
    expect(spec.args).toEqual(["--headless", "--native"]);
  });

  it("throws on the local channel when the sibling fleet-cli build is missing instead of falling back to the global binary", () => {
    const resolve = createDefaultTerminalLaunchResolver({
      ...baseDeps,
      exists: () => false,
    });

    expect(() => resolve("/work")).toThrow(/sibling fleet-cli build was not found/);
  });

  it("honors a FLEET_TERMINAL_CMD override verbatim without forcing headless native flags", () => {
    const resolve = createDefaultTerminalLaunchResolver({
      ...baseDeps,
      env: { FLEET_TERMINAL_CMD: "bash -l" } as NodeJS.ProcessEnv,
      exists: () => false,
    });

    const spec = resolve("/work");

    expect(spec.bin).toBe("bash");
    expect(spec.args).toEqual(["-l"]);
  });

  it("injects selected cwd and console session env for spawned terminal sessions", () => {
    const resolve = createDefaultTerminalLaunchResolver({
      ...baseDeps,
      release: STABLE_RELEASE,
      env: { EXISTING: "kept" } as NodeJS.ProcessEnv,
      exists: () => false,
    });

    const spec = resolve("/work/project", { sessionId: "session-a" });

    expect(spec.cwd).toBe("/work/project");
    expect(spec.env).toMatchObject({
      EXISTING: "kept",
      FLEET_CONSOLE_SESSION_ID: "session-a",
      INIT_CWD: "/work/project",
      PWD: "/work/project",
      TERM: "xterm-256color",
    });
  });

  it("launches the user's shell without fleet-cli overrides for shell sessions", () => {
    const resolve = createDefaultTerminalLaunchResolver({
      ...baseDeps,
      env: { FLEET_TERMINAL_CMD: "fleet --headless", SHELL: "/bin/zsh" } as NodeJS.ProcessEnv,
      exists: (candidate) => candidate === LOCAL_CLI_ENTRY,
    });

    const spec = resolve("", { sessionId: "shell", kind: "shell" });

    expect(spec).toMatchObject({
      bin: "/bin/zsh",
      args: [],
      cwd: "/work",
    });
    expect(spec.env).toMatchObject({ TERM: "xterm-256color" });
    expect(spec.env.FLEET_CONSOLE_SESSION_ID).toBeUndefined();
    expect(spec.env.INIT_CWD).toBeUndefined();
  });
});
