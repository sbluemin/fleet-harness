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
  it("runtime/fleet-wiki-ui/dist/cli-bin.mjs를 부모 방향으로 탐색해 찾는다", async () => {
    const distDir = path.join(tempDir, "runtime", "fleet-wiki-ui", "dist");
    await mkdir(distDir, { recursive: true });
    const cliPath = path.join(distDir, "cli-bin.mjs");
    await writeFile(cliPath, "// stub\n", "utf8");

    const nestedCwd = path.join(tempDir, "packages", "some-package", "src");
    await mkdir(nestedCwd, { recursive: true });

    expect(findLocalCliMjs(nestedCwd)).toBe(cliPath);
    expect(findLocalCliMjs(tempDir)).toBe(cliPath);
  });

  it("cli-bin.mjs가 없으면 구버전 worktree 호환을 위해 cli.mjs로 폴백한다", async () => {
    const distDir = path.join(tempDir, "runtime", "fleet-wiki-ui", "dist");
    await mkdir(distDir, { recursive: true });
    const legacyCliPath = path.join(distDir, "cli.mjs");
    await writeFile(legacyCliPath, "// stub\n", "utf8");

    expect(findLocalCliMjs(tempDir)).toBe(legacyCliPath);
  });

  it("cli-bin.mjs를 cli.mjs보다 우선한다", async () => {
    const distDir = path.join(tempDir, "runtime", "fleet-wiki-ui", "dist");
    await mkdir(distDir, { recursive: true });
    const cliBinPath = path.join(distDir, "cli-bin.mjs");
    await writeFile(cliBinPath, "// stub\n", "utf8");
    await writeFile(path.join(distDir, "cli.mjs"), "// legacy stub\n", "utf8");

    expect(findLocalCliMjs(tempDir)).toBe(cliBinPath);
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
