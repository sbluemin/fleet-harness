import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findLocalCliMjs } from "../src/cli.js";

let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-trampoline-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("findLocalCliMjs", () => {
  it("runtime/fleet-wiki-ui/dist/cli.mjs를 부모 방향으로 탐색해 찾는다", async () => {
    const distDir = path.join(tempDir, "runtime", "fleet-wiki-ui", "dist");
    await mkdir(distDir, { recursive: true });
    const cliPath = path.join(distDir, "cli.mjs");
    await writeFile(cliPath, "// stub\n", "utf8");

    const nestedCwd = path.join(tempDir, "packages", "some-package", "src");
    await mkdir(nestedCwd, { recursive: true });

    expect(findLocalCliMjs(nestedCwd)).toBe(cliPath);
    expect(findLocalCliMjs(tempDir)).toBe(cliPath);
  });

  it("로컬 dist가 없으면 null을 반환한다", () => {
    expect(findLocalCliMjs(tempDir)).toBeNull();
  });

  it("구 경로(packages/fleet-wiki-ui)는 더 이상 매치하지 않는다", async () => {
    const legacyDistDir = path.join(tempDir, "packages", "fleet-wiki-ui", "dist");
    await mkdir(legacyDistDir, { recursive: true });
    await writeFile(path.join(legacyDistDir, "cli.mjs"), "// stub\n", "utf8");

    expect(findLocalCliMjs(tempDir)).toBeNull();
  });
});
