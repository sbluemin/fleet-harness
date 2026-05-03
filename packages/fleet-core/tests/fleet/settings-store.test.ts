import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let testHomeDir = "";

beforeEach(() => {
  testHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-core-settings-store-"));
  vi.resetModules();
  vi.doMock("node:os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:os")>();
    return {
      ...actual,
      homedir: () => testHomeDir,
    };
  });
});

afterEach(() => {
  vi.doUnmock("node:os");
  vi.resetModules();
  cleanupTestHome();
});

describe("core settings store", () => {
  it("does not write settings through a symlinked settings.json", async () => {
    const fleetDir = path.join(testHomeDir, ".fleet");
    const outsideFile = path.join(testHomeDir, "outside-settings.json");
    fs.mkdirSync(fleetDir, { recursive: true });
    fs.writeFileSync(outsideFile, "{\"outside\":true}");
    fs.symlinkSync(outsideFile, path.join(fleetDir, "settings.json"));

    const store = await import("../../src/infra/settings/store.js");

    store.saveSection("core-log", { enabled: true });

    expect(fs.readFileSync(outsideFile, "utf-8")).toBe("{\"outside\":true}");
    expect(fs.lstatSync(path.join(fleetDir, "settings.json")).isSymbolicLink()).toBe(true);
  });

  it("keeps the Fleet settings directory owner-only", async () => {
    const fleetDir = path.join(testHomeDir, ".fleet");
    fs.mkdirSync(fleetDir, { mode: 0o777, recursive: true });

    const store = await import("../../src/infra/settings/store.js");

    store.saveSection("core-log", { enabled: true });

    expect(fs.statSync(fleetDir).mode & 0o777).toBe(0o700);
  });
});

function cleanupTestHome(): void {
  try {
    if (testHomeDir.length > 0) {
      fs.rmSync(testHomeDir, { force: true, recursive: true });
    }
  } catch {
    // 테스트 정리 실패 시 무시
  } finally {
    testHomeDir = "";
  }
}
