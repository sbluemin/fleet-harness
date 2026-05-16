import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureMemoryRoot, resolveMemoryPaths } from "../src/paths.js";
import {
  DEFAULT_WORKSPACE_KNOWLEDGE_AGENTS,
  REQUIRED_WORKSPACE_SCHEMA_SECTIONS,
  WORKSPACE_KNOWLEDGE_AGENTS_FILENAME,
  WORKSPACE_SCHEMA_AGENTS_FILENAME,
  WORKSPACE_SCHEMA_FILENAME,
  ensureWorkspaceDoctrine,
  ensureWorkspaceSchema,
  readWorkspaceSchemaSummary,
} from "../src/schema.js";
import { pathExists } from "../src/store.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("workspace schema", () => {
  it("creates schema/AGENTS.md and schema/wiki-schema.md during ensureMemoryRoot", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await ensureMemoryRoot(paths);

    expect(await pathExists(path.join(paths.root, WORKSPACE_KNOWLEDGE_AGENTS_FILENAME))).toBe(true);
    expect(await pathExists(path.join(paths.schemaDir, WORKSPACE_SCHEMA_AGENTS_FILENAME))).toBe(true);
    expect(await pathExists(path.join(paths.schemaDir, WORKSPACE_SCHEMA_FILENAME))).toBe(true);
  });

  it("creates the workspace doctrine AGENTS.md seed byte-for-byte", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await ensureWorkspaceDoctrine(paths);
    const doctrine = await readFile(path.join(paths.root, WORKSPACE_KNOWLEDGE_AGENTS_FILENAME), "utf8");

    expect(doctrine).toBe(DEFAULT_WORKSPACE_KNOWLEDGE_AGENTS);
  });

  it("is idempotent across repeated ensureWorkspaceSchema calls", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await ensureWorkspaceSchema(paths);
    const firstAgents = await readFile(path.join(paths.schemaDir, WORKSPACE_SCHEMA_AGENTS_FILENAME), "utf8");
    const firstWikiSchema = await readFile(path.join(paths.schemaDir, WORKSPACE_SCHEMA_FILENAME), "utf8");

    await ensureWorkspaceSchema(paths);
    const secondAgents = await readFile(path.join(paths.schemaDir, WORKSPACE_SCHEMA_AGENTS_FILENAME), "utf8");
    const secondWikiSchema = await readFile(path.join(paths.schemaDir, WORKSPACE_SCHEMA_FILENAME), "utf8");

    expect(secondAgents).toBe(firstAgents);
    expect(secondWikiSchema).toBe(firstWikiSchema);
  });

  it("is idempotent across repeated ensureWorkspaceDoctrine calls", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await ensureWorkspaceDoctrine(paths);
    const firstDoctrine = await readFile(path.join(paths.root, WORKSPACE_KNOWLEDGE_AGENTS_FILENAME), "utf8");

    await ensureWorkspaceDoctrine(paths);
    const secondDoctrine = await readFile(path.join(paths.root, WORKSPACE_KNOWLEDGE_AGENTS_FILENAME), "utf8");

    expect(secondDoctrine).toBe(firstDoctrine);
  });

  it("preserves user edits when ensureWorkspaceSchema runs again", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await ensureWorkspaceSchema(paths);
    const schemaPath = path.join(paths.schemaDir, WORKSPACE_SCHEMA_FILENAME);
    await writeFile(schemaPath, "# User Schema\n\n## Canonical Link Syntax\n\ncustom content\n", "utf8");

    await ensureWorkspaceSchema(paths);
    const preserved = await readFile(schemaPath, "utf8");

    expect(preserved).toContain("custom content");
    expect(preserved.startsWith("# User Schema")).toBe(true);
  });

  it("preserves user edits when ensureWorkspaceDoctrine runs again", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await ensureWorkspaceDoctrine(paths);
    const doctrinePath = path.join(paths.root, WORKSPACE_KNOWLEDGE_AGENTS_FILENAME);
    await writeFile(doctrinePath, "# User Doctrine\n\ncustom doctrine\n", "utf8");

    await ensureWorkspaceDoctrine(paths);
    const preserved = await readFile(doctrinePath, "utf8");

    expect(preserved).toContain("custom doctrine");
    expect(preserved.startsWith("# User Doctrine")).toBe(true);
  });

  it("returns a complete summary for the default workspace schema", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await ensureWorkspaceSchema(paths);
    const summary = await readWorkspaceSchemaSummary(paths);

    expect(summary.exists).toBe(true);
    expect(summary.requiredSections).toEqual(REQUIRED_WORKSPACE_SCHEMA_SECTIONS);
    expect(summary.missingRequiredSections).toEqual([]);
    expect(summary.summary.length).toBeGreaterThan(0);
  });

  it("does not recreate a deleted wiki-schema file when reading summary", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await ensureWorkspaceSchema(paths);
    const schemaPath = path.join(paths.schemaDir, WORKSPACE_SCHEMA_FILENAME);
    await unlink(schemaPath);

    const summary = await readWorkspaceSchemaSummary(paths);

    expect(summary.exists).toBe(false);
    expect(summary.missingRequiredSections).toEqual([...REQUIRED_WORKSPACE_SCHEMA_SECTIONS]);
    expect(await pathExists(schemaPath)).toBe(false);
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-schema-"));
  cleanupPaths.push(root);
  return root;
}
