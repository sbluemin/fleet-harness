import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  byteSpanToUtf16,
  invalidateSearchCatalog,
  rankPath,
  searchFilesWithRipgrep,
} from "../server/search-engine.js";

describe("ripgrep file search engine", () => {
  let root = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-rg-search-"));
    await fs.mkdir(path.join(root, "src", "nested"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "FleetSearchCoordinator.ts"), "export const 한글Needle = '🌊';\n");
    await fs.writeFile(path.join(root, "src", "nested", "search-contract.test.ts"), "test('provider auth')\n");
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.writeFile(path.join(root, ".git", "FleetSearchCoordinator.ts"), "hidden\n");
    invalidateSearchCatalog();
  });

  afterEach(async () => {
    invalidateSearchCatalog();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("ranks camel initials and returns UTF-16 path ranges without absolute paths", async () => {
    const result = await searchFilesWithRipgrep(root, "fsc", 20, { scope: "files" });

    expect(result.engine).toBe("ripgrep");
    expect(result.complete).toBe(false);
    expect(result.ignoredSkipped).toBe(true);
    expect(result.files[0]?.relativePath).toBe("src/FleetSearchCoordinator.ts");
    expect(result.files[0]?.pathRanges).toEqual([
      { start: 4, end: 5 },
      { start: 9, end: 10 },
      { start: 13, end: 14 },
    ]);
    expect(JSON.stringify(result)).not.toContain(root);
    expect(result.files.some((item) => item.relativePath.startsWith(".git/"))).toBe(false);
  });

  it("returns content snippets with 1-based lines and browser UTF-16 ranges", async () => {
    const result = await searchFilesWithRipgrep(root, "한글Needle", 20, { scope: "contents" });
    const hit = result.files[0];

    expect(result.complete).toBe(false);
    expect(result.ignoredSkipped).toBe(true);
    expect(hit?.source).toBe("content");
    expect(hit?.preview).toMatchObject({
      lineNumber: 1,
      text: "export const 한글Needle = '🌊';",
      ranges: [{ start: 13, end: 21 }],
    });
  });

  it("does not let one aborted caller poison the shared path catalog", async () => {
    const controller = new AbortController();
    const first = searchFilesWithRipgrep(root, "fsc", 20, { scope: "files", signal: controller.signal });
    controller.abort();
    await first;

    const next = await searchFilesWithRipgrep(root, "fsc", 20, { scope: "files" });
    expect(next.files[0]?.relativePath).toBe("src/FleetSearchCoordinator.ts");
  });

  it("finds an ignored path on the zero-result fallback", async () => {
    await fs.writeFile(path.join(root, ".gitignore"), "ignored/\n");
    await fs.mkdir(path.join(root, "ignored"));
    await fs.writeFile(path.join(root, "ignored", "only-ignored-needle.ts"), "export {}\n");
    invalidateSearchCatalog();

    const result = await searchFilesWithRipgrep(root, "only-ignored-needle", 20, { scope: "files" });
    expect(result.files[0]?.relativePath).toBe("ignored/only-ignored-needle.ts");
    expect(result.ignoredSkipped).toBe(false);
    expect(result.complete).toBe(true);
  });

  it("marks mixed visible and ignored filename results as incomplete", async () => {
    await fs.writeFile(path.join(root, ".gitignore"), "ignored/\n");
    await fs.mkdir(path.join(root, "ignored"));
    await fs.writeFile(path.join(root, "src", "mixed-needle.ts"), "export {}\n");
    await fs.writeFile(path.join(root, "ignored", "mixed-needle.ts"), "export {}\n");
    invalidateSearchCatalog();

    const result = await searchFilesWithRipgrep(root, "mixed-needle", 20, { scope: "files" });
    expect(result.files.map((item) => item.relativePath)).toEqual(["src/mixed-needle.ts"]);
    expect(result.ignoredSkipped).toBe(true);
    expect(result.complete).toBe(false);
  });

  it("invalidates the cached file catalog after changes", async () => {
    const first = await searchFilesWithRipgrep(root, "later", 20, { scope: "files" });
    expect(first.files).toEqual([]);

    await fs.writeFile(path.join(root, "src", "later.ts"), "later\n");
    const cached = await searchFilesWithRipgrep(root, "later", 20, { scope: "files" });
    expect(cached.files).toEqual([]);

    invalidateSearchCatalog();
    const refreshed = await searchFilesWithRipgrep(root, "later", 20, { scope: "files" });
    expect(refreshed.files[0]?.relativePath).toBe("src/later.ts");
  });

  it("converts UTF-8 byte submatches into UTF-16 half-open ranges", () => {
    const buffer = Buffer.from("a한🌊z", "utf8");
    expect(byteSpanToUtf16(buffer, 1, 4)).toEqual({ start: 1, end: 2 });
    expect(byteSpanToUtf16(buffer, 4, 8)).toEqual({ start: 2, end: 4 });
  });

  it("keeps exact basename above prefix and fuzzy candidates", () => {
    const exact = rankPath("src/needle", "needle");
    const prefix = rankPath("src/needle-extra.ts", "needle");
    const fuzzy = rankPath("src/NewEditorEntry.ts", "nee");
    expect(exact?.score).toBeGreaterThan(prefix?.score ?? 0);
    expect(prefix?.score).toBeGreaterThan(fuzzy?.score ?? 0);
  });

  it("does not collect fuzzy letters across directory segments", () => {
    expect(rankPath("fleet/search/command.ts", "fsc")).toBeNull();
    expect(rankPath("src/FleetSearchCoordinator.ts", "fsc")).not.toBeNull();
  });
});
