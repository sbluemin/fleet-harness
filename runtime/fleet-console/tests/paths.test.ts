import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createConsoleDataPaths, createConsolePaths } from "../core/host/paths.js";

const TEST_UID = 42;

describe("createConsolePaths", () => {
  it("creates separate default lock directories for local and stable channels", () => {
    const packageRoot = "/repo/runtime/fleet-console";
    const expectedLocalDir = path.join(path.resolve(packageRoot, "..", ".."), ".fleet", "console");

    const local = createConsolePaths({ channel: "local", env: {}, packageRoot, uid: TEST_UID });
    const stable = createConsolePaths({ channel: "stable", env: {}, packageRoot, uid: TEST_UID });

    expect(local.dir).toBe(expectedLocalDir);
    expect(stable.dir).toBe(path.join(os.tmpdir(), `fleet-console-${TEST_UID}-stable`));
    expect(local.lockFile).toBe(path.join(local.dir, "console.lock"));
    expect(stable.lockFile).toBe(path.join(stable.dir, "console.lock"));
    expect(local.dir).not.toBe(stable.dir);
  });

  it("honors FLEET_CONSOLE_DIR regardless of channel", () => {
    const overrideDir = path.join(os.tmpdir(), "fleet-console-override");
    const env = { FLEET_CONSOLE_DIR: overrideDir } as NodeJS.ProcessEnv;

    const local = createConsolePaths({ channel: "local", env, uid: TEST_UID });
    const stable = createConsolePaths({ channel: "stable", env, uid: TEST_UID });

    expect(local.dir).toBe(overrideDir);
    expect(stable.dir).toBe(overrideDir);
    expect(local.lockFile).toBe(path.join(overrideDir, "console.lock"));
    expect(stable.lockFile).toBe(path.join(overrideDir, "console.lock"));
  });
});

describe("createConsoleDataPaths", () => {
  it("persists stable durable state under the Fleet data directory without changing lock paths", () => {
    const fleetDataDir = path.join(os.tmpdir(), "fleet-data-root");
    const lock = createConsolePaths({ channel: "stable", env: {}, uid: TEST_UID });
    const data = createConsoleDataPaths({ channel: "stable", env: {}, fleetDataDir });

    expect(lock.dir).toBe(path.join(os.tmpdir(), `fleet-console-${TEST_UID}-stable`));
    expect(data.dir).toBe(path.join(fleetDataDir, "console"));
    expect(data.stateFile).toBe(path.join(fleetDataDir, "console", "state.json"));
    expect(data.settingsFile).toBe(path.join(fleetDataDir, "console", "settings.json"));
  });

  it("uses stable durable data without a Desktop release channel", () => {
    const fleetDataDir = path.join(os.tmpdir(), "fleet-data-root");
    const stable = createConsoleDataPaths({ channel: "stable", env: {}, fleetDataDir });

    expect(createConsoleDataPaths({ env: {}, fleetDataDir })).toEqual(stable);
  });

  it("isolates local durable state into the project .fleet/console slot shared with the lock", () => {
    const packageRoot = "/repo/runtime/fleet-console";
    const expectedLocalDir = path.join(path.resolve(packageRoot, "..", ".."), ".fleet", "console");

    const lock = createConsolePaths({ channel: "local", env: {}, packageRoot, uid: TEST_UID });
    const data = createConsoleDataPaths({ channel: "local", env: {}, packageRoot });

    // local 채널의 durable state는 ~/.fleet가 아니라 프로젝트 .fleet/console에 격리되어 lock과 같은 슬롯을 공유한다.
    expect(data.dir).toBe(expectedLocalDir);
    expect(data.dir).toBe(lock.dir);
    expect(data.stateFile).toBe(path.join(expectedLocalDir, "state.json"));
    expect(data.settingsFile).toBe(path.join(expectedLocalDir, "settings.json"));
  });

  it("honors FLEET_CONSOLE_DIR for durable state regardless of channel, co-located with the lock", () => {
    const overrideDir = path.join(os.tmpdir(), "fleet-console-override");
    const env = { FLEET_CONSOLE_DIR: overrideDir } as NodeJS.ProcessEnv;

    // FLEET_CONSOLE_DIR escape hatch: durable state도 lock과 동일하게 override 슬롯으로 옮겨져야 한다
    // (read-only 체크아웃에서 쓰기 가능 런타임 슬롯을 지정하는 경우, 체크아웃이 아닌 그 슬롯에 격리).
    const local = createConsoleDataPaths({ channel: "local", env, packageRoot: "/repo/runtime/fleet-console" });
    const stable = createConsoleDataPaths({ channel: "stable", env });
    const lock = createConsolePaths({ channel: "local", env, packageRoot: "/repo/runtime/fleet-console" });

    expect(local.dir).toBe(overrideDir);
    expect(stable.dir).toBe(overrideDir);
    expect(local.dir).toBe(lock.dir);
    expect(local.stateFile).toBe(path.join(overrideDir, "state.json"));
    expect(local.settingsFile).toBe(path.join(overrideDir, "settings.json"));
  });

  it("lets an explicit fleetDataDir take precedence over both the channel and FLEET_CONSOLE_DIR", () => {
    const packageRoot = "/repo/runtime/fleet-console";
    const fleetDataDir = path.join(os.tmpdir(), "fleet-data-root");
    const overrideDir = path.join(os.tmpdir(), "fleet-console-override");
    const expectedLocalDir = path.join(path.resolve(packageRoot, "..", ".."), ".fleet", "console");
    const env = { FLEET_CONSOLE_DIR: overrideDir } as NodeJS.ProcessEnv;

    // 명시 fleetDataDir(테스트/임베드)은 채널 추론과 FLEET_CONSOLE_DIR보다 우선해 <fleetDataDir>/console을 쓴다.
    const data = createConsoleDataPaths({ channel: "local", env, packageRoot, fleetDataDir });

    expect(data.dir).toBe(path.join(fleetDataDir, "console"));
    expect(data.dir).not.toBe(expectedLocalDir);
    expect(data.dir).not.toBe(overrideDir);
  });
});
