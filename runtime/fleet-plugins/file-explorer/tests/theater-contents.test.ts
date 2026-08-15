import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { listTheaterContents } from "../server/tree-services.js";

describe("listTheaterContents", () => {
  it("dotfile(.env)과 dotfolder(.hidden)를 결과에 포함한다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-contents-"));
    fs.writeFileSync(path.join(dir, "readme.md"), "hello");
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, ".env"), "SECRET=1");
    fs.mkdirSync(path.join(dir, ".hidden"));

    const result = await listTheaterContents(dir, "");
    const names = result.entries.map((e) => e.name);

    expect(names).toContain(".env");
    expect(names).toContain(".hidden");
    expect(names).toContain("readme.md");
    expect(names).toContain("src");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("디렉터리가 먼저, 그다음 이름순으로 정렬한다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-contents-sort-"));
    fs.writeFileSync(path.join(dir, "b.ts"), "");
    fs.writeFileSync(path.join(dir, "a.ts"), "");
    fs.mkdirSync(path.join(dir, "pkg"));

    const result = await listTheaterContents(dir, "");

    expect(result.entries.at(0)?.kind).toBe("dir");
    const fileNames = result.entries.filter((e) => e.kind === "file").map((e) => e.name);
    expect(fileNames).toEqual([...fileNames].sort((a, b) => a.localeCompare(b)));

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    { entryCount: 499, expectedLength: 499, truncated: false },
    { entryCount: 500, expectedLength: 500, truncated: false },
    { entryCount: 501, expectedLength: 500, truncated: true },
  ])("$entryCount개 항목에서 500개 cap과 truncation을 유지한다", async ({ entryCount, expectedLength, truncated }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-contents-cap-"));
    const opendir = vi.fn(fs.promises.opendir);
    for (let index = 0; index < entryCount; index++) {
      fs.writeFileSync(path.join(dir, `file-${String(index).padStart(3, "0")}.txt`), "");
    }

    try {
      const result = await listTheaterContents(dir, "", { opendir });

      expect(opendir).toHaveBeenCalledWith(fs.realpathSync(dir), { bufferSize: 501 });
      expect(result.entries).toHaveLength(expectedLength);
      if (truncated) {
        expect(result).toMatchObject({ truncated: true, cap: 500 });
      } else {
        expect(result).not.toHaveProperty("truncated");
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("VCS 날것(.git/.svn/.hg)은 목록에서 빼고 hiddenVcsInternals로 알린다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-contents-vcs-"));
    fs.mkdirSync(path.join(dir, ".git"));
    fs.mkdirSync(path.join(dir, ".svn"));
    fs.mkdirSync(path.join(dir, ".hg"));
    fs.writeFileSync(path.join(dir, ".env"), "SECRET=1");
    fs.mkdirSync(path.join(dir, "src"));

    try {
      const result = await listTheaterContents(dir, "");
      const names = result.entries.map((e) => e.name);

      expect(names).not.toContain(".git");
      expect(names).not.toContain(".svn");
      expect(names).not.toContain(".hg");
      expect(names).toContain(".env");
      expect(names).toContain("src");
      expect(result.hiddenVcsInternals).toEqual([".git", ".hg", ".svn"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("VCS 날것이 없으면 hiddenVcsInternals를 생략한다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-contents-novcs-"));
    fs.mkdirSync(path.join(dir, "src"));

    try {
      const result = await listTheaterContents(dir, "");

      expect(result).not.toHaveProperty("hiddenVcsInternals");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("VCS 날것은 항목 상한 카운트에 포함하지 않는다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-contents-vcscap-"));
    fs.mkdirSync(path.join(dir, ".git"));
    for (let index = 0; index < 500; index++) {
      fs.writeFileSync(path.join(dir, `file-${String(index).padStart(3, "0")}.txt`), "");
    }

    try {
      const result = await listTheaterContents(dir, "");

      expect(result.entries).toHaveLength(500);
      expect(result).not.toHaveProperty("truncated");
      expect(result.hiddenVcsInternals).toEqual([".git"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
