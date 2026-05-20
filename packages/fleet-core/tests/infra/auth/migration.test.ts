import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LEGACY_AUTH_PATH,
  CURRENT_AUTH_PATH,
  mergeAuthStoresNoOverwrite,
  migrateLegacyAuthStore,
} from "../../../src/infra/auth/index.js";

const tempRoots: string[] = [];

describe("auth migration", () => {
  afterEach(() => {
    for (const tempRoot of tempRoots.splice(0)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("defines the legacy and current auth paths", () => {
    expect(LEGACY_AUTH_PATH).toBe(path.join(os.homedir(), ".fleet", "agent", "auth.json"));
    expect(CURRENT_AUTH_PATH).toBe(path.join(os.homedir(), ".fleet", "auth.json"));
  });

  it("merges legacy providers without overwriting current providers", () => {
    expect(mergeAuthStoresNoOverwrite(
      {
        "Claude Code with Z.AI GLM": { key: "legacy-zai" },
        "Claude Code with Moonshot Kimi": { key: "legacy-kimi" },
      },
      {
        "Claude Code with Moonshot Kimi": { key: "current-kimi" },
      },
    )).toEqual({
      data: {
        "Claude Code with Z.AI GLM": { key: "legacy-zai" },
        "Claude Code with Moonshot Kimi": { key: "current-kimi" },
      },
      migratedProviderIds: ["Claude Code with Z.AI GLM"],
      skippedProviderIds: ["Claude Code with Moonshot Kimi"],
    });
  });

  it("does nothing when the legacy auth file is absent", async () => {
    const paths = createTempAuthPaths();

    await expect(migrateLegacyAuthStore(paths)).resolves.toMatchObject({
      migratedCount: 0,
      skippedCount: 0,
      shouldPrintNotice: false,
      status: "legacy-missing",
    });
    expect(fs.existsSync(paths.currentPath)).toBe(false);
  });

  it("creates the current auth file from legacy entries when current is absent", async () => {
    const paths = createTempAuthPaths();

    writeJson(paths.legacyPath, {
      "Claude Code with Z.AI GLM": { key: "legacy-zai" },
      "Claude Code with Moonshot Kimi": { key: "legacy-kimi" },
    });

    await expect(migrateLegacyAuthStore(paths)).resolves.toMatchObject({
      migratedCount: 2,
      skippedCount: 0,
      migratedProviderIds: [
        "Claude Code with Z.AI GLM",
        "Claude Code with Moonshot Kimi",
      ],
      shouldPrintNotice: true,
      status: "migrated",
    });
    expect(readJson(paths.currentPath)).toEqual({
      "Claude Code with Z.AI GLM": { key: "legacy-zai" },
      "Claude Code with Moonshot Kimi": { key: "legacy-kimi" },
    });
    expect(fs.existsSync(paths.legacyPath)).toBe(true);
  });

  it("copies only missing providers and keeps existing current entries", async () => {
    const paths = createTempAuthPaths();

    writeJson(paths.legacyPath, {
      "Claude Code with Z.AI GLM": { key: "legacy-zai" },
      "Claude Code with Moonshot Kimi": { key: "legacy-kimi" },
    });
    writeJson(paths.currentPath, {
      "Claude Code with Moonshot Kimi": { key: "current-kimi" },
    });

    await expect(migrateLegacyAuthStore(paths)).resolves.toMatchObject({
      migratedCount: 1,
      skippedCount: 1,
      migratedProviderIds: ["Claude Code with Z.AI GLM"],
      skippedProviderIds: ["Claude Code with Moonshot Kimi"],
      shouldPrintNotice: true,
      status: "migrated",
    });
    expect(readJson(paths.currentPath)).toEqual({
      "Claude Code with Z.AI GLM": { key: "legacy-zai" },
      "Claude Code with Moonshot Kimi": { key: "current-kimi" },
    });
  });

  it("does not rewrite the current auth file when every legacy provider already exists", async () => {
    const paths = createTempAuthPaths();

    writeJson(paths.legacyPath, {
      "Claude Code with Z.AI GLM": { key: "legacy-zai" },
    });
    writeJson(paths.currentPath, {
      "Claude Code with Z.AI GLM": { key: "current-zai" },
    });

    const before = fs.statSync(paths.currentPath).mtimeMs;

    await expect(migrateLegacyAuthStore(paths)).resolves.toMatchObject({
      migratedCount: 0,
      skippedCount: 1,
      shouldPrintNotice: false,
      status: "unchanged",
    });
    expect(readJson(paths.currentPath)).toEqual({
      "Claude Code with Z.AI GLM": { key: "current-zai" },
    });
    expect(fs.statSync(paths.currentPath).mtimeMs).toBe(before);
  });
});

function createTempAuthPaths(): { legacyPath: string; currentPath: string } {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-auth-migration-"));
  tempRoots.push(tempRoot);
  return {
    legacyPath: path.join(tempRoot, ".fleet", "agent", "auth.json"),
    currentPath: path.join(tempRoot, ".fleet", "auth.json"),
  };
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}
