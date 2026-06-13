import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createNativeFolderPicker } from "../src/terminal/folder-picker.js";
import { createFolderGrantStore, validateAbsoluteDirectory } from "../src/terminal/folder-grants.js";

describe("folder grants", () => {
  it("consumes folder grants exactly once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-grant-"));
    const store = createFolderGrantStore({ randomId: () => "grant-a" });

    const grantId = store.issue(dir);

    expect(grantId).toBe("grant-a");
    expect(store.consume(grantId)).toBe(dir);
    expect(store.consume(grantId)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts only absolute directories", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-grant-"));
    const file = path.join(dir, "file.txt");
    fs.writeFileSync(file, "x");

    expect(validateAbsoluteDirectory(dir)).toBe(dir);
    expect(() => validateAbsoluteDirectory("relative")).toThrow("invalid_folder");
    expect(() => validateAbsoluteDirectory(file)).toThrow("invalid_folder");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("expires folder grants after the TTL so a leaked grant cannot be reused later", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-grant-"));
    let clock = 1_000;
    const store = createFolderGrantStore({ randomId: () => "grant-ttl", ttlMs: 500, now: () => clock });

    const grantId = store.issue(dir);
    clock += 600; // TTL(500ms) 초과

    expect(store.consume(grantId)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("native folder picker", () => {
  it("returns cancelled when the native dialog is cancelled", async () => {
    const pick = createNativeFolderPicker({
      platform: "darwin",
      runCommand: async () => {
        const error = new Error("User canceled.") as NodeJS.ErrnoException & { stderr?: string };
        error.stderr = "User canceled.";
        throw error;
      },
    });

    await expect(pick()).resolves.toEqual({ kind: "cancelled" });
  });

  it("returns dialog_unavailable when platform commands are missing", async () => {
    const pick = createNativeFolderPicker({
      platform: "linux",
      runCommand: async () => {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
    });

    await expect(pick()).resolves.toEqual({ kind: "error", error: "dialog_unavailable" });
  });

  it("returns dialog_timeout when the native dialog times out", async () => {
    const pick = createNativeFolderPicker({
      platform: "darwin",
      runCommand: async () => {
        const error = new Error("timeout") as NodeJS.ErrnoException;
        error.code = "ETIMEDOUT";
        throw error;
      },
    });

    await expect(pick()).resolves.toEqual({ kind: "error", error: "dialog_timeout" });
  });

  it("returns invalid_folder when the selected path is not an absolute directory", async () => {
    const pick = createNativeFolderPicker({
      platform: "darwin",
      runCommand: async () => ({ stdout: "relative\n" }),
    });

    await expect(pick()).resolves.toEqual({ kind: "error", error: "invalid_folder" });
  });
});
