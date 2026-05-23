import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureMemoryRoot, resolveMemoryPaths } from "../src/paths.js";
import {
  DEFAULT_WORKSPACE_KNOWLEDGE_AGENTS,
  DEFAULT_TEMPLATE_GUIDE,
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
    expect(await pathExists(path.join(paths.schemaDir, `${WORKSPACE_TEMPLATE_PREFIX}guide${WORKSPACE_TEMPLATE_SUFFIX}`))).toBe(true);
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
    const firstPrdTemplate = await readFile(path.join(paths.schemaDir, "template-prd.md"), "utf8");
    const firstGuideTemplate = await readFile(path.join(paths.schemaDir, "template-guide.md"), "utf8");

    await ensureWorkspaceSchema(paths);
    const secondAgents = await readFile(path.join(paths.schemaDir, WORKSPACE_SCHEMA_AGENTS_FILENAME), "utf8");
    const secondWikiSchema = await readFile(path.join(paths.schemaDir, WORKSPACE_SCHEMA_FILENAME), "utf8");
    const secondPrdTemplate = await readFile(path.join(paths.schemaDir, "template-prd.md"), "utf8");
    const secondGuideTemplate = await readFile(path.join(paths.schemaDir, "template-guide.md"), "utf8");

    expect(secondAgents).toBe(firstAgents);
    expect(secondWikiSchema).toBe(firstWikiSchema);
    expect(secondPrdTemplate).toBe(firstPrdTemplate);
    expect(secondGuideTemplate).toBe(firstGuideTemplate);
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
    expect(summary.templates?.map((template) => template.id)).toEqual(["guide", "prd"]);
    expect(summary.summary.length).toBeGreaterThan(0);
  });

  it("creates default template seeds and scans their required sections deterministically", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await ensureWorkspaceSchema(paths);
    const prdTemplate = await readFile(path.join(paths.schemaDir, "template-prd.md"), "utf8");
    const guideTemplate = await readFile(path.join(paths.schemaDir, "template-guide.md"), "utf8");
    const templates = await scanTemplates(paths);

    expect(prdTemplate).toBe(DEFAULT_TEMPLATE_PRD);
    expect(guideTemplate).toBe(DEFAULT_TEMPLATE_GUIDE);
    expect(templates.map((template) => template.id)).toEqual(["guide", "prd"]);
    expect(templates.find((template) => template.id === "prd")?.sections).toEqual([
      "Overview",
      "Problem",
      "Goals",
      "Non-Goals",
      "User Stories",
      "Functional Requirements",
      "Acceptance Criteria",
      "Open Questions",
      "Related",
    ]);
    expect(templates.find((template) => template.id === "guide")?.sections).toEqual(["Overview", "Related"]);
  });

  it("validates selected template sections as an order-insensitive subset", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    await ensureWorkspaceSchema(paths);

    await expect(validateTemplateCompliance(paths, "guide", "## Related\n\nlinks\n\n## Overview\n\nsummary")).resolves.toBeUndefined();
    await expect(validateTemplateCompliance(paths, "guide", "## Overview\n\nsummary")).rejects.toThrow("missing sections: Related");
  });

  it("documents current raw provenance and pending patch edit workflow", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await ensureWorkspaceSchema(paths);
    await ensureWorkspaceDoctrine(paths);
    const schema = await readFile(path.join(paths.schemaDir, WORKSPACE_SCHEMA_FILENAME), "utf8");
    const schemaAgents = await readFile(path.join(paths.schemaDir, WORKSPACE_SCHEMA_AGENTS_FILENAME), "utf8");
    const doctrine = await readFile(path.join(paths.root, WORKSPACE_KNOWLEDGE_AGENTS_FILENAME), "utf8");

    expect(schema).toContain("`rawSourceRef`: Latest immutable raw provenance ref");
    expect(schema).toContain("`rawSourceRefs`: Ordered provenance history");
    expect(schema).not.toContain("`rawSourceRef`, `status`, `kind`");
    expect(schema).toContain("`wiki_patch_edit` may revise already-pending queue proposals");
    expect(schema).toContain("schema/template-{id}.md");
    expect(schema).toContain("patch approval enforce selected template body sections");
    expect(schemaAgents).toContain("Treat `rawSourceRef` as current latest-provenance metadata.");
    expect(doctrine).toContain("already-pending queue proposal revisions may use `wiki_patch_edit`");
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
