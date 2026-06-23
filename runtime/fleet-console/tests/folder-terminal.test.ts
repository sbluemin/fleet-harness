import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listTerminalFolders, normalizeFolderBrowserPath, TerminalFolderListError } from "../core/host/terminal/folder-browser.js";
import { createFolderGrantStore, validateAbsoluteDirectory } from "../core/host/terminal/folder-grants.js";

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

describe("terminal folder browser", () => {
  it("lists roots without spawning platform commands", async () => {
    const listed = await listTerminalFolders(null, {
      platform: "linux",
      homedir: () => "/",
      stat: (async () => ({ isDirectory: () => true }) as fs.Stats) as unknown as typeof fs.promises.stat,
      opendir: (async () => ({
        read: async () => null,
        close: async () => undefined,
      }) as unknown as fs.Dir) as unknown as typeof fs.promises.opendir,
    });

    expect(listed.roots).toEqual(["/"]);
    expect(listed.path).toBe(path.resolve("/"));
  });

  it("returns directories only and downgrades inaccessible symlink entries", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-browser-"));
    const child = path.join(dir, "child");
    const file = path.join(dir, "file.txt");
    fs.mkdirSync(child);
    fs.writeFileSync(file, "x");
    fs.symlinkSync(child, path.join(dir, "child-link"), "dir");
    fs.symlinkSync(path.join(dir, "missing"), path.join(dir, "broken-link"), "dir");

    const listed = await listTerminalFolders(dir);

    expect(listed.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "child", kind: "dir", accessible: true }),
      expect.objectContaining({ name: "child-link", kind: "dir", accessible: true }),
      expect.objectContaining({ name: "broken-link", kind: "dir", accessible: false }),
    ]));
    expect(listed.entries.some((entry) => entry.name === "file.txt")).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("caps entries and marks truncated", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-browser-cap-"));
    for (let index = 0; index < 505; index += 1) fs.mkdirSync(path.join(dir, `d-${index}`));

    const listed = await listTerminalFolders(dir);

    expect(listed.entries).toHaveLength(500);
    expect(listed.truncated).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stops streaming directory entries once the cap is exceeded", async () => {
    const dirents = Array.from({ length: 600 }, (_, index) => ({
      name: `d-${index}`,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    })) as fs.Dirent[];
    let closed = false;
    let reads = 0;

    const listed = await listTerminalFolders(path.resolve(os.tmpdir()), {
      platform: "linux",
      stat: (async () => ({ isDirectory: () => true }) as fs.Stats) as unknown as typeof fs.promises.stat,
      opendir: (async () => ({
        read: async () => dirents[reads++] ?? null,
        close: async () => {
          closed = true;
        },
      }) as unknown as fs.Dir) as unknown as typeof fs.promises.opendir,
    });

    expect(listed.entries).toHaveLength(500);
    expect(listed.truncated).toBe(true);
    expect(reads).toBe(501);
    expect(closed).toBe(true);
  });

  it("rejects invalid paths before filesystem access", () => {
    expect(() => normalizeFolderBrowserPath("relative")).toThrow(TerminalFolderListError);
    expect(() => normalizeFolderBrowserPath("bad\0path")).toThrow(TerminalFolderListError);
    expect(() => normalizeFolderBrowserPath("C:relative", "win32")).toThrow(TerminalFolderListError);
    expect(() => normalizeFolderBrowserPath("\\root-relative", "win32")).toThrow(TerminalFolderListError);
  });

  it("maps filesystem errors", async () => {
    await expect(listTerminalFolders(path.join(os.tmpdir(), "fleet-console-missing-dir"))).rejects.toMatchObject({ code: "not_found" });
    await expect(listTerminalFolders(os.tmpdir(), {
      stat: async () => {
        const error = new Error("denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      },
    })).rejects.toMatchObject({ code: "forbidden" });
  });
});
