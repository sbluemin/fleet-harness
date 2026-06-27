import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listTheaterContents } from "../server/folder-browser.js";

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
});
