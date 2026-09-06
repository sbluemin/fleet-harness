import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listTheaterFolders, normalizeFolderBrowserPath, TheaterFolderListError } from "../core/host/theaters/theater-domain.js";
import { createFolderGrantStore, validateAbsoluteDirectory } from "../core/host/theaters/theater-domain.js";

describe("folder grants", () => {
  it("consumes folder grants exactly once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-grant-"));
    const store = createFolderGrantStore({ randomId: () => "grant-a" });

    const grantId = store.issue(dir);

    expect(grantId).toBe("grant-a");
    expect(store.consume(grantId)).toBe(path.resolve(dir));
    expect(store.consume(grantId)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts only absolute directories", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-grant-"));
    const file = path.join(dir, "file.txt");
    fs.writeFileSync(file, "x");

    expect(validateAbsoluteDirectory(dir)).toBe(path.resolve(dir));
    expect(() => validateAbsoluteDirectory("relative")).toThrow("invalid_folder");
    expect(() => validateAbsoluteDirectory("bad\0path")).toThrow("invalid_folder");
    expect(() => validateAbsoluteDirectory(file)).toThrow("invalid_folder");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("expires folder grants after the TTL so a leaked grant cannot be reused later", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-grant-"));
    let clock = 1_000;
    const store = createFolderGrantStore({ randomId: () => "grant-ttl", ttlMs: 500, now: () => clock });

    const grantId = store.issue(dir);
    clock += 600;

    expect(store.consume(grantId)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("Theater folder browser", () => {

  it("rejects invalid paths before filesystem access", () => {
    expect(() => normalizeFolderBrowserPath("relative")).toThrow(TheaterFolderListError);
    expect(() => normalizeFolderBrowserPath("bad\0path")).toThrow(TheaterFolderListError);
    expect(() => normalizeFolderBrowserPath("C:relative", "win32")).toThrow(TheaterFolderListError);
    expect(() => normalizeFolderBrowserPath("\\root-relative", "win32")).toThrow(TheaterFolderListError);
  });
});
