import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createConsoleDataPaths, createConsolePaths } from "../src/paths.js";

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
    const data = createConsoleDataPaths({ channel: "stable", fleetDataDir });

    expect(lock.dir).toBe(path.join(os.tmpdir(), `fleet-console-${TEST_UID}-stable`));
    expect(data.dir).toBe(path.join(fleetDataDir, "console"));
    expect(data.stateFile).toBe(path.join(fleetDataDir, "console", "state.json"));
    expect(data.capturesDir).toBe(path.join(fleetDataDir, "console", "captures"));
  });

  it("isolates local durable state into the project .fleet/console slot shared with the lock", () => {
    const packageRoot = "/repo/runtime/fleet-console";
    const expectedLocalDir = path.join(path.resolve(packageRoot, "..", ".."), ".fleet", "console");

    const lock = createConsolePaths({ channel: "local", env: {}, packageRoot, uid: TEST_UID });
    const data = createConsoleDataPaths({ channel: "local", packageRoot });

    // local 채널의 durable state는 ~/.fleet가 아니라 프로젝트 .fleet/console에 격리되어 lock과 같은 슬롯을 공유한다.
    expect(data.dir).toBe(expectedLocalDir);
    expect(data.dir).toBe(lock.dir);
    expect(data.stateFile).toBe(path.join(expectedLocalDir, "state.json"));
    expect(data.capturesDir).toBe(path.join(expectedLocalDir, "captures"));
  });

  it("lets an explicit fleetDataDir override the channel-based data root", () => {
    const packageRoot = "/repo/runtime/fleet-console";
    const fleetDataDir = path.join(os.tmpdir(), "fleet-data-root");
    const expectedLocalDir = path.join(path.resolve(packageRoot, "..", ".."), ".fleet", "console");

    // 명시 fleetDataDir(테스트/임베드)은 local 채널 추론보다 우선해 <fleetDataDir>/console을 데이터 루트로 쓴다.
    const data = createConsoleDataPaths({ channel: "local", packageRoot, fleetDataDir });

    expect(data.dir).toBe(path.join(fleetDataDir, "console"));
    expect(data.dir).not.toBe(expectedLocalDir);
  });
});
