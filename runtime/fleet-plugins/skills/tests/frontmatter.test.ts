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

describe("parseSkillDescription", () => {
  it("reads a single-line description", () => {
    const md = "---\nname: clean-code\ndescription: Diagnose over-abstraction in a package.\n---\n\n# Clean code\n";
    expect(parseSkillDescription(md)).toBe("Diagnose over-abstraction in a package.");
  });

  it("joins a folded description across indented continuation lines", () => {
    const md = "---\nname: x\ndescription: First part of the sentence\n  and the continuation line.\nallowed-tools: Bash(x:*)\n---\n";
    expect(parseSkillDescription(md)).toBe("First part of the sentence and the continuation line.");
  });

  it("strips surrounding quotes", () => {
    expect(parseSkillDescription('---\ndescription: "Quoted value"\n---\n')).toBe("Quoted value");
    expect(parseSkillDescription("---\ndescription: 'Quoted value'\n---\n")).toBe("Quoted value");
  });

  it("tolerates CRLF line endings and a BOM", () => {
    expect(parseSkillDescription("﻿---\r\nname: x\r\ndescription: Windows line endings.\r\n---\r\n"))
      .toBe("Windows line endings.");
  });

  it("does not treat a later body key as frontmatter", () => {
    const md = "---\nname: x\n---\n\n# Title\n\ndescription: this is prose, not frontmatter\n";
    expect(parseSkillDescription(md)).toBeUndefined();
  });

  it("returns undefined when there is no frontmatter, no key, or an empty value", () => {
    expect(parseSkillDescription("# Just a heading\n")).toBeUndefined();
    expect(parseSkillDescription("---\nname: x\n---\n")).toBeUndefined();
    expect(parseSkillDescription("---\ndescription:\n---\n")).toBeUndefined();
  });

  it("refuses block scalars rather than guessing at their value", () => {
    expect(parseSkillDescription("---\ndescription: >\n  folded block\n---\n")).toBeUndefined();
    expect(parseSkillDescription("---\ndescription: |\n  literal block\n---\n")).toBeUndefined();
  });

  it("refuses a frontmatter block with no closing delimiter", () => {
    // 머리 8KB 안에서 닫히지 않았다면 잘린 조각을 읽은 것이다 — 값으로 믿지 않는다.
    expect(parseSkillDescription("---\ndescription: Truncated before the close\n")).toBeUndefined();
  });

  it("caps a pathologically long value so one file cannot bloat the list response", () => {
    const long = "x".repeat(4000);
    expect(parseSkillDescription(`---\ndescription: ${long}\n---\n`)).toHaveLength(500);
  });
});

// ─── reader ──────────────────────────────────────────────────────────────────

describe("readSkillDescription", () => {
  it("reads the description of a hand-authored .claude/skills entry", async () => {
    const { root, skillDir } = await makeSkill(
      "console-e2e",
      "---\nname: console-e2e\ndescription: Drive a headless real-browser end-to-end test.\n---\n\n# body\n",
    );
    await expect(readSkillDescription(skillDir, root)).resolves
      .toBe("Drive a headless real-browser end-to-end test.");
  });

  it("returns undefined when SKILL.md is absent", async () => {
    const { root, skillDir } = await makeSkill("no-file", null);
    await expect(readSkillDescription(skillDir, root)).resolves.toBeUndefined();
  });

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

  it("does not throw when the path is unreadable", async () => {
    await expect(readSkillDescription("/nonexistent/skill", "/nonexistent")).resolves.toBeUndefined();
  });
});
