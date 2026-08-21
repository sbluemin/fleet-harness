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

  it("600개 폴더는 readdir 순서와 무관하게 이름순 앞 500개만 보인다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-contents-600-"));
    const dirents = Array.from({ length: 600 }, (_, index) => {
      const nameIndex = 599 - index;
      return {
        name: `file-${String(nameIndex).padStart(3, "0")}.txt`,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      };
    });
    const fakeOpendir = async () => ({
      read: async () => dirents.shift() ?? null,
      close: async () => undefined,
    });

    try {
      const result = await listTheaterContents(dir, "", { opendir: fakeOpendir as unknown as typeof fs.promises.opendir });

      expect(result.entries).toHaveLength(500);
      expect(result).toMatchObject({ truncated: true, cap: 500 });
      expect(result.entries.map((entry) => entry.name)).toEqual(
        Array.from({ length: 500 }, (_, index) => `file-${String(index).padStart(3, "0")}.txt`),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("검색이 건너뛰는 의존성/빌드 디렉터리도 목록에는 남긴다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-contents-ignored-"));
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.mkdirSync(path.join(dir, "dist"));
    fs.writeFileSync(path.join(dir, "readme.md"), "");

    try {
      const result = await listTheaterContents(dir, "");
      const names = result.entries.map((entry) => entry.name);
      expect(names).toContain("node_modules");
      expect(names).toContain("dist");
      expect(names).toContain("readme.md");
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

  it("500개 항목 뒤에 오는 .git도 cap 판정 전에 기록한다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-contents-order-"));
    // readdir 순서를 통제하기 위해 opendir을 스텁한다: 파일 500개를 먼저, .git을 마지막에 낸다.
    const dirents = [
      ...Array.from({ length: 500 }, (_, i) => ({
        name: `file-${String(i).padStart(3, "0")}.txt`,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      })),
      {
        name: ".git",
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
      },
    ];
    const fakeOpendir = async () => ({
      read: async () => dirents.shift() ?? null,
      close: async () => undefined,
    });

    try {
      const result = await listTheaterContents(dir, "", { opendir: fakeOpendir as unknown as typeof fs.promises.opendir });

      // 표시 가능한 항목은 정확히 500개 — 잘린 것이 없으므로 truncated가 아니어야 하고,
      // .git은 cap 판정 전에 분류되어 마커 정보가 남아야 한다.
      expect(result.entries).toHaveLength(500);
      expect(result).not.toHaveProperty("truncated");
      expect(result.hiddenVcsInternals).toEqual([".git"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("표시 상한 이후의 심링크 꼬리는 실해석하지 않고 truncated로 알린다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-contents-aliascap-"));
    fs.mkdirSync(path.join(dir, ".git"));
    fs.symlinkSync(path.join(dir, ".git"), path.join(dir, "z-metadata"), "dir");
    const realpath = vi.spyOn(fs.promises, "realpath");
    const stat = vi.spyOn(fs.promises, "stat");
    // 이름순 cap: file-* 가 z-* 보다 앞이므로 심링크 꼬리는 잘린 뒤에 남는다.
    const dirents = [
      ...Array.from({ length: 500 }, (_, i) => ({
        name: `file-${String(i).padStart(3, "0")}.txt`,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      })),
      {
        name: "z-metadata",
        isDirectory: () => false,
        isFile: () => false,
        isSymbolicLink: () => true,
      },
      ...Array.from({ length: 32 }, (_, i) => ({
        name: `z-alias-${String(i).padStart(2, "0")}`,
        isDirectory: () => false,
        isFile: () => false,
        isSymbolicLink: () => true,
      })),
    ];
    const fakeOpendir = async () => ({
      read: async () => dirents.shift() ?? null,
      close: async () => undefined,
    });

    try {
      const result = await listTheaterContents(dir, "", {
        opendir: fakeOpendir as unknown as typeof fs.promises.opendir,
      });

      expect(result.entries).toHaveLength(500);
      expect(result).toMatchObject({ truncated: true, cap: 500 });
      expect(result).not.toHaveProperty("hiddenVcsInternals");
      // 루트/대상 containment용 realpath 2회만 — 상한 이후 심링크는 분류하지 않는다.
      expect(realpath).toHaveBeenCalledTimes(2);
      // 대상 디렉터리 판별 1회 + 수집된 엔트리 정렬 메타(attachEntryStats) 500회.
      expect(stat).toHaveBeenCalledTimes(1 + 500);
    } finally {
      realpath.mockRestore();
      stat.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("심링크 배치가 상한을 넘기면 디렉터리 끝에서도 truncated이다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-contents-batchcap-"));
    fs.writeFileSync(path.join(dir, "target.txt"), "");
    for (let index = 0; index < 16; index++) {
      fs.symlinkSync(path.join(dir, "target.txt"), path.join(dir, `link-${String(index).padStart(2, "0")}`));
    }
    const dirents = [
      ...Array.from({ length: 485 }, (_, i) => ({
        name: `file-${String(i).padStart(3, "0")}.txt`,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      })),
      ...Array.from({ length: 16 }, (_, i) => ({
        name: `link-${String(i).padStart(2, "0")}`,
        isDirectory: () => false,
        isFile: () => false,
        isSymbolicLink: () => true,
      })),
    ];
    const fakeOpendir = async () => ({
      read: async () => dirents.shift() ?? null,
      close: async () => undefined,
    });

    try {
      const result = await listTheaterContents(dir, "", {
        opendir: fakeOpendir as unknown as typeof fs.promises.opendir,
      });

      expect(result.entries).toHaveLength(500);
      expect(result).toMatchObject({ truncated: true, cap: 500 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("상한을 넘는 심링크 배치는 남은 칸만 실해석한다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-contents-remain-"));
    fs.writeFileSync(path.join(dir, "target.txt"), "");
    for (let index = 0; index < 16; index++) {
      fs.symlinkSync(path.join(dir, "target.txt"), path.join(dir, `link-${String(index).padStart(2, "0")}`));
    }
    const realpath = vi.spyOn(fs.promises, "realpath");
    const dirents = [
      ...Array.from({ length: 499 }, (_, i) => ({
        name: `file-${String(i).padStart(3, "0")}.txt`,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      })),
      ...Array.from({ length: 16 }, (_, i) => ({
        name: `link-${String(i).padStart(2, "0")}`,
        isDirectory: () => false,
        isFile: () => false,
        isSymbolicLink: () => true,
      })),
    ];
    const fakeOpendir = async () => ({
      read: async () => dirents.shift() ?? null,
      close: async () => undefined,
    });

    try {
      const result = await listTheaterContents(dir, "", {
        opendir: fakeOpendir as unknown as typeof fs.promises.opendir,
      });

      expect(result.entries).toHaveLength(500);
      expect(result).toMatchObject({ truncated: true, cap: 500 });
      // containment 2회 + 상한을 채우는 심링크 1회만.
      expect(realpath).toHaveBeenCalledTimes(3);
    } finally {
      realpath.mockRestore();
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
