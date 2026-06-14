import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createConsolePaths } from "../src/paths.js";

const TEST_UID = 42;

describe("createConsolePaths", () => {
  it("creates separate default lock directories for local and stable channels", () => {
    const local = createConsolePaths({ channel: "local", env: {}, uid: TEST_UID });
    const stable = createConsolePaths({ channel: "stable", env: {}, uid: TEST_UID });

    expect(local.dir).toBe(path.join(os.tmpdir(), `fleet-console-${TEST_UID}-local`));
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
