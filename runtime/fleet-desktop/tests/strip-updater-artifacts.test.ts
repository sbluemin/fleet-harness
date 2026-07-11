import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isUpdaterArtifact, removeUpdaterArtifacts } from "../scripts/strip-updater-artifacts.mjs";

const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))); });

describe("strip updater artifacts", () => {
  it("classifies blockmap and latest*.yml as updater artifacts, keeps real deliverables", () => {
    expect(isUpdaterArtifact("Fleet Console-1.0.0-mac-arm64.dmg.blockmap")).toBe(true);
    expect(isUpdaterArtifact("latest-mac.yml")).toBe(true);
    expect(isUpdaterArtifact("latest.yml")).toBe(true);
    expect(isUpdaterArtifact("Fleet Console-1.0.0-mac-arm64.dmg")).toBe(false);
    expect(isUpdaterArtifact("Fleet Console-1.0.0-mac-arm64.zip")).toBe(false);
  });

  it("removes only updater artifacts from the output tree, recursively", async () => {
    const out = await mkdtemp(path.join(os.tmpdir(), "fc-strip-"));
    roots.push(out);
    await writeFile(path.join(out, "Fleet Console-1.0.0-mac-arm64.dmg"), "dmg");
    await writeFile(path.join(out, "Fleet Console-1.0.0-mac-arm64.dmg.blockmap"), "blk");
    await writeFile(path.join(out, "Fleet Console-1.0.0-mac-arm64.zip"), "zip");
    await writeFile(path.join(out, "Fleet Console-1.0.0-mac-arm64.zip.blockmap"), "blk");
    await writeFile(path.join(out, "latest-mac.yml"), "yml");
    await mkdir(path.join(out, "mac-arm64"), { recursive: true });
    await writeFile(path.join(out, "mac-arm64", "nested.blockmap"), "blk");

    const removed = await removeUpdaterArtifacts(out);

    expect(removed.sort()).toEqual(["Fleet Console-1.0.0-mac-arm64.dmg.blockmap", "Fleet Console-1.0.0-mac-arm64.zip.blockmap", "latest-mac.yml", "nested.blockmap"].sort());
    expect((await readdir(out)).sort()).toEqual(["Fleet Console-1.0.0-mac-arm64.dmg", "Fleet Console-1.0.0-mac-arm64.zip", "mac-arm64"].sort());
    expect(await readdir(path.join(out, "mac-arm64"))).toEqual([]);
  });
});
