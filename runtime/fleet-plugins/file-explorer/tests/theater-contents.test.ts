import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { listTheaterContents } from "../server/tree-services.js";

describe("listTheaterContents", () => {

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
        expect(result.entries.map((entry) => entry.name)).toEqual(
          Array.from({ length: expectedLength }, (_, index) => `file-${String(index).padStart(3, "0")}.txt`),
        );
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
});

describe("listTheaterContents VCS edge cases", () => {
  it(".git을 가리키는 심링크 별칭도 VCS 날것으로 분류해 숨긴다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-contents-alias-"));
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main");
    fs.symlinkSync(path.join(dir, ".git"), path.join(dir, "metadata"), "dir");

    try {
      const result = await listTheaterContents(dir, "");
      const names = result.entries.map((e) => e.name);

      expect(names).not.toContain("metadata");
      expect(result.hiddenVcsInternals).toContain(".git");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("listTheaterContents resolved-target quarantine", () => {
  it("요청된 폴터가 VCS 날것으로 실해석되면 수집을 거부한다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-contents-retarget-"));
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main");
    // 처음엔 정상 디렉터리를 가리키다가 .git으로 리타기팅된 별칭을 재현한다.
    fs.symlinkSync(path.join(dir, ".git"), path.join(dir, "metadata"), "dir");

    try {
      await expect(listTheaterContents(dir, "metadata")).rejects.toMatchObject({ code: "forbidden" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
