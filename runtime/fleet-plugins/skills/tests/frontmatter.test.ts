import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseSkillDescription, readSkillDescription } from "../server/frontmatter.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

const created: string[] = [];

async function makeSkill(name: string, contents: string | null): Promise<{ root: string; skillDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-skills-fm-"));
  created.push(root);
  const skillDir = path.join(root, ".claude", "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  if (contents !== null) await fs.writeFile(path.join(skillDir, "SKILL.md"), contents, "utf-8");
  return { root, skillDir };
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

// ─── parser ──────────────────────────────────────────────────────────────────

// ─── reader ──────────────────────────────────────────────────────────────────

describe("readSkillDescription", () => {

  it("refuses a skill directory that resolves outside the scope root", async () => {
    // CLI가 보고한 경로라도 scope 경계를 벗어나면 읽지 않는다.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-skills-outside-"));
    created.push(outside);
    await fs.writeFile(path.join(outside, "SKILL.md"), "---\ndescription: Secret.\n---\n", "utf-8");
    const { root } = await makeSkill("decoy", "---\ndescription: ok\n---\n");

    await expect(readSkillDescription(outside, root)).resolves.toBeUndefined();
  });

  it("refuses a symlinked SKILL.md that escapes the skill directory", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-skills-escape-"));
    created.push(outside);
    const secret = path.join(outside, "secret.md");
    await fs.writeFile(secret, "---\ndescription: Secret.\n---\n", "utf-8");

    const { root, skillDir } = await makeSkill("linked", null);
    await fs.symlink(secret, path.join(skillDir, "SKILL.md"));

    await expect(readSkillDescription(skillDir, root)).resolves.toBeUndefined();
  });
});
