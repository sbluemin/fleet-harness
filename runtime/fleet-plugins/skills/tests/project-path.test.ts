import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveProjectCwd } from "../server/project-path.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface ProjectPathFixture {
  readonly root: string;
}

// ─── module state ────────────────────────────────────────────────────────────

const temporaryDirectories: string[] = [];

// ─── functions ───────────────────────────────────────────────────────────────

async function makeFixture(): Promise<ProjectPathFixture> {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-skills-path-"));
  temporaryDirectories.push(temporaryDirectory);
  const root = path.join(temporaryDirectory, "theater");
  await fs.mkdir(root, { recursive: true });
  return { root };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

describe("resolveProjectCwd", () => {
  it("uses the canonical Theater root as the project cwd", async () => {
    const fixture = await makeFixture();

    await expect(resolveProjectCwd(fixture.root)).resolves.toBe(await fs.realpath(fixture.root));
  });

  it("rejects missing and non-directory Theater roots", async () => {
    const fixture = await makeFixture();
    await expect(resolveProjectCwd(path.join(fixture.root, "missing"))).rejects.toMatchObject({ code: "not_found" });
    const file = path.join(fixture.root, "file");
    await fs.writeFile(file, "x");
    await expect(resolveProjectCwd(file)).rejects.toMatchObject({ code: "invalid_path" });
  });
});
