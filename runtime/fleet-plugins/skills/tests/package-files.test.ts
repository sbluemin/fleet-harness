import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildSkillDisplayPath,
  inspectSkillPackage,
  readSkillPackageFile,
  SKILL_PACKAGE_LIMITS,
} from "../server/package-files.js";

describe("skill package files", () => {
  it("groups supported files without following hidden entries or symlinks", async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-skills-package-"));
    const skillRoot = path.join(temporaryDirectory, ".claude", "skills", "console-e2e");
    await fs.mkdir(path.join(skillRoot, "references"), { recursive: true });
    await fs.mkdir(path.join(skillRoot, "scripts"), { recursive: true });
    await fs.writeFile(path.join(skillRoot, "SKILL.md"), "# Entry\n[Remote](references/remote.md)\n");
    await fs.writeFile(path.join(skillRoot, "references", "remote.md"), "# Remote\n");
    await fs.writeFile(path.join(skillRoot, "scripts", "close.mjs"), "process.exit(0);\n");
    await fs.writeFile(path.join(skillRoot, ".secret"), "hidden\n");
    await fs.symlink(path.join(skillRoot, "references", "remote.md"), path.join(skillRoot, "reference-link.md"));

    try {
      const manifest = await inspectSkillPackage(skillRoot, temporaryDirectory);
      expect(manifest.files.map((file) => [file.path, file.role, file.format])).toEqual([
        ["SKILL.md", "entry", "markdown"],
        ["references/remote.md", "reference", "markdown"],
        ["scripts/close.mjs", "script", "code"],
      ]);
      expect(manifest.omittedSymlinks).toBe(1);
      expect(manifest.files.some((file) => file.path === ".secret")).toBe(false);
    } finally {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("derives an honest display path from the verified CLI entry", async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-skills-display-"));
    const skillRoot = path.join(temporaryDirectory, ".claude", "skills", "console-e2e");
    await fs.mkdir(skillRoot, { recursive: true });
    try {
      await expect(buildSkillDisplayPath(skillRoot, temporaryDirectory, "project"))
        .resolves.toBe(".claude/skills/console-e2e");
      await expect(buildSkillDisplayPath(skillRoot, temporaryDirectory, "global"))
        .resolves.toBe("~/.claude/skills/console-e2e");
    } finally {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("reads only a validated package-relative text file", async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-skills-read-"));
    const skillRoot = path.join(temporaryDirectory, "skills", "sample");
    await fs.mkdir(path.join(skillRoot, "references"), { recursive: true });
    await fs.writeFile(path.join(skillRoot, "SKILL.md"), "# Entry\n");
    await fs.writeFile(path.join(skillRoot, "references", "guide.md"), "# Guide\n");
    try {
      const result = await readSkillPackageFile(skillRoot, temporaryDirectory, "references/guide.md");
      expect(result.content).toBe("# Guide\n");
      expect(result.file.format).toBe("markdown");
      await expect(readSkillPackageFile(skillRoot, temporaryDirectory, "../secret.md"))
        .rejects.toThrow("invalid_file_path");
    } finally {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("rejects symlinked files instead of following them", async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-skills-symlink-"));
    const skillRoot = path.join(temporaryDirectory, "skills", "sample");
    const outsideFile = path.join(temporaryDirectory, "outside.md");
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(outsideFile, "# Outside\n");
    await fs.symlink(outsideFile, path.join(skillRoot, "linked.md"));
    try {
      await expect(readSkillPackageFile(skillRoot, temporaryDirectory, "linked.md"))
        .rejects.toThrow("symlink_not_allowed");
    } finally {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("counts directories toward the manifest entry limit", async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-skills-entry-limit-"));
    const skillRoot = path.join(temporaryDirectory, "skills", "sample");
    await fs.mkdir(skillRoot, { recursive: true });
    await Promise.all(Array.from({ length: SKILL_PACKAGE_LIMITS.maxEntries + 1 }, (_, index) =>
      fs.mkdir(path.join(skillRoot, `folder-${String(index).padStart(3, "0")}`))));
    try {
      const manifest = await inspectSkillPackage(skillRoot, temporaryDirectory);
      expect(manifest.truncated).toBe(true);
      expect(manifest.folderCount).toBe(SKILL_PACKAGE_LIMITS.maxEntries);
    } finally {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("marks oversized files as unreadable", async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-skills-large-"));
    const skillRoot = path.join(temporaryDirectory, "skills", "sample");
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(path.join(skillRoot, "SKILL.md"), "# Entry\n");
    await fs.writeFile(path.join(skillRoot, "large.txt"), Buffer.alloc(SKILL_PACKAGE_LIMITS.maxFileBytes + 1, 97));
    try {
      const manifest = await inspectSkillPackage(skillRoot, temporaryDirectory);
      expect(manifest.files.find((file) => file.path === "large.txt")?.readable).toBe(false);
      await expect(readSkillPackageFile(skillRoot, temporaryDirectory, "large.txt"))
        .rejects.toThrow("file_too_large");
    } finally {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
