import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createConsoleDataPaths, createConsolePaths } from "../core/host/paths.js";

const TEST_UID = 42;

describe("createConsoleDataPaths", () => {

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
});
