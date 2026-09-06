import { afterEach, describe, expect, it } from "vitest";
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureMemoryRoot, resolveMemoryPaths } from "../src/paths.js";
import {
  DEFAULT_WORKSPACE_KNOWLEDGE_AGENTS,
  DEFAULT_TEMPLATE_PRD,
  REQUIRED_WORKSPACE_SCHEMA_SECTIONS,
  WORKSPACE_KNOWLEDGE_AGENTS_FILENAME,
  WORKSPACE_SCHEMA_AGENTS_FILENAME,
  WORKSPACE_SCHEMA_FILENAME,
  WORKSPACE_TEMPLATE_PREFIX,
  WORKSPACE_TEMPLATE_SUFFIX,
  ensureWorkspaceDoctrine,
  ensureWorkspaceSchema,
  readWorkspaceSchemaSummary,
  scanTemplates,
  validateTemplateCompliance,
} from "../src/schema.js";
import { pathExists } from "../src/store.js";

const PRE_EXISTING_DOCTRINE = "# Pre-existing workspace doctrine\n\nunchanged bytes\n";

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
    expect(await pathExists(path.join(paths.schemaDir, `${WORKSPACE_TEMPLATE_PREFIX}prd${WORKSPACE_TEMPLATE_SUFFIX}`))).toBe(true);
  });

  it("does not follow or replace symlinked doctrine paths", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const doctrinePath = path.join(paths.root, WORKSPACE_KNOWLEDGE_AGENTS_FILENAME);
    const linkTarget = path.join(paths.root, "existing-doctrine.md");

    await mkdir(paths.root, { recursive: true });
    await writeFile(linkTarget, PRE_EXISTING_DOCTRINE, "utf8");
    await symlink(linkTarget, doctrinePath);
    await ensureWorkspaceDoctrine(paths);

    expect(await readFile(linkTarget, "utf8")).toBe(PRE_EXISTING_DOCTRINE);
    expect(await readFile(doctrinePath, "utf8")).toBe(PRE_EXISTING_DOCTRINE);
    expect((await lstat(doctrinePath)).isSymbolicLink()).toBe(true);
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
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-schema-"));
  cleanupPaths.push(root);
  return root;
}
