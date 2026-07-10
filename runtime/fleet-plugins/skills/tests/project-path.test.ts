import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveProjectCwd } from "../server/project-path.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface ProjectPathFixture {
  readonly outside: string;
  readonly root: string;
  readonly selected: string;
}

// ─── module state ────────────────────────────────────────────────────────────

const temporaryDirectories: string[] = [];

// ─── functions ───────────────────────────────────────────────────────────────

async function makeFixture(): Promise<ProjectPathFixture> {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-skills-path-"));
  temporaryDirectories.push(temporaryDirectory);
  const root = path.join(temporaryDirectory, "theater");
  const selected = path.join(root, "nested");
  const outside = path.join(temporaryDirectory, "outside");
  await Promise.all([fs.mkdir(selected, { recursive: true }), fs.mkdir(outside)]);
  return { outside, root, selected };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

describe("resolveProjectCwd", () => {
  it("uses the selected contained directory as the project cwd", async () => {
    const fixture = await makeFixture();

    await expect(resolveProjectCwd(fixture.root, "nested")).resolves.toBe(await fs.realpath(fixture.selected));
  });

  it.each(["/tmp/escape", "C:\\escape", "\\\\server\\share", "../escape", "nested/../../escape"])(
    "rejects unsafe relPath %s before use",
    async (relPath) => {
      const fixture = await makeFixture();

      await expect(resolveProjectCwd(fixture.root, relPath)).rejects.toMatchObject({
        code: "invalid_rel_path",
      });
    },
  );

  it("rejects a symlink that escapes the theater after realpath resolution", async () => {
    const fixture = await makeFixture();
    await fs.symlink(fixture.outside, path.join(fixture.root, "escape"));

    await expect(resolveProjectCwd(fixture.root, "escape")).rejects.toMatchObject({
      code: "path_outside_theater",
    });
  });
});
