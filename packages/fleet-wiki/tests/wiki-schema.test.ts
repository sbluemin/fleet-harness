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

  it("creates the workspace doctrine AGENTS.md seed byte-for-byte when missing", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await ensureWorkspaceDoctrine(paths);
    const doctrine = await readFile(path.join(paths.root, WORKSPACE_KNOWLEDGE_AGENTS_FILENAME), "utf8");

    expect(doctrine).toBe(DEFAULT_WORKSPACE_KNOWLEDGE_AGENTS);
    expect(doctrine).not.toContain("Chronicle");
  });

  it("preserves arbitrary existing doctrine byte-for-byte across repeated calls", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const doctrinePath = path.join(paths.root, WORKSPACE_KNOWLEDGE_AGENTS_FILENAME);

    await mkdir(paths.root, { recursive: true });
    await writeFile(doctrinePath, PRE_EXISTING_DOCTRINE, "utf8");
    await ensureWorkspaceDoctrine(paths);
    await ensureWorkspaceDoctrine(paths);

    expect(await readFile(doctrinePath, "utf8")).toBe(PRE_EXISTING_DOCTRINE);
  });

  it("preserves readable 0444 custom and current doctrine without changing bytes or mode", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const doctrinePath = path.join(paths.root, WORKSPACE_KNOWLEDGE_AGENTS_FILENAME);
    const customDoctrine = "# User Doctrine\n\ncustom doctrine\n";

    await mkdir(paths.root, { recursive: true });
    await writeFile(doctrinePath, customDoctrine, { mode: 0o444 });
    await ensureWorkspaceDoctrine(paths);
    expect(await readFile(doctrinePath, "utf8")).toBe(customDoctrine);
    expect((await stat(doctrinePath)).mode & 0o777).toBe(0o444);

    await chmod(doctrinePath, 0o644);
    await writeFile(doctrinePath, DEFAULT_WORKSPACE_KNOWLEDGE_AGENTS, "utf8");
    await chmod(doctrinePath, 0o444);
    await ensureWorkspaceDoctrine(paths);
    expect(await readFile(doctrinePath, "utf8")).toBe(DEFAULT_WORKSPACE_KNOWLEDGE_AGENTS);
    expect((await stat(doctrinePath)).mode & 0o777).toBe(0o444);
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

  it("does not replace an existing doctrine directory", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const doctrinePath = path.join(paths.root, WORKSPACE_KNOWLEDGE_AGENTS_FILENAME);

    await mkdir(paths.root, { recursive: true });
    await mkdir(doctrinePath);
    await ensureWorkspaceDoctrine(paths);

    expect(await pathExists(doctrinePath)).toBe(true);
    expect((await lstat(doctrinePath)).isDirectory()).toBe(true);
  });

  it("is idempotent across repeated ensureWorkspaceSchema calls", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await ensureWorkspaceSchema(paths);
    const firstAgents = await readFile(path.join(paths.schemaDir, WORKSPACE_SCHEMA_AGENTS_FILENAME), "utf8");
    const firstWikiSchema = await readFile(path.join(paths.schemaDir, WORKSPACE_SCHEMA_FILENAME), "utf8");
    const firstPrdTemplate = await readFile(path.join(paths.schemaDir, "template-prd.md"), "utf8");

    await ensureWorkspaceSchema(paths);
    const secondAgents = await readFile(path.join(paths.schemaDir, WORKSPACE_SCHEMA_AGENTS_FILENAME), "utf8");
    const secondWikiSchema = await readFile(path.join(paths.schemaDir, WORKSPACE_SCHEMA_FILENAME), "utf8");
    const secondPrdTemplate = await readFile(path.join(paths.schemaDir, "template-prd.md"), "utf8");

    expect(secondAgents).toBe(firstAgents);
    expect(secondWikiSchema).toBe(firstWikiSchema);
    expect(secondPrdTemplate).toBe(firstPrdTemplate);
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
    expect(summary.templates?.map((template) => template.id)).toEqual(["prd"]);
    expect(summary.summary.length).toBeGreaterThan(0);
  });

  it("creates default template seeds and scans their required sections deterministically", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await ensureWorkspaceSchema(paths);
    const prdTemplate = await readFile(path.join(paths.schemaDir, "template-prd.md"), "utf8");
    const templates = await scanTemplates(paths);

    expect(prdTemplate).toBe(DEFAULT_TEMPLATE_PRD);
    expect(templates.map((template) => template.id)).toEqual(["prd"]);
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
  });

  it("validates selected template sections as an order-insensitive subset", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    await ensureWorkspaceSchema(paths);

    await expect(validateTemplateCompliance(paths, "prd", [
      "## Related",
      "",
      "links",
      "",
      "## Open Questions",
      "",
      "none",
      "",
      "## Acceptance Criteria",
      "",
      "criteria",
      "",
      "## Functional Requirements",
      "",
      "requirements",
      "",
      "## User Stories",
      "",
      "stories",
      "",
      "## Non-Goals",
      "",
      "out of scope",
      "",
      "## Goals",
      "",
      "goals",
      "",
      "## Problem",
      "",
      "problem",
      "",
      "## Overview",
      "",
      "summary",
    ].join("\n"))).resolves.toBeUndefined();
    await expect(validateTemplateCompliance(paths, "prd", "## Overview\n\nsummary")).rejects.toThrow("missing sections: Problem");
  });

  it("ignores fenced headings consistently in template catalogs and entry compliance", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    await ensureWorkspaceSchema(paths);
    await writeFile(path.join(paths.schemaDir, "template-fenced.md"), [
      "---",
      "template_id: fenced",
      "description: Fence-aware template.",
      "---",
      "# Fenced Template",
      "",
      "```md",
      "## Example Only",
      "```",
      "",
      "## Real Section",
    ].join("\n"), "utf8");

    const templates = await scanTemplates(paths);

    expect(templates.find((template) => template.id === "fenced")?.sections).toEqual(["Real Section"]);
    await expect(validateTemplateCompliance(paths, "fenced", "```md\n## Real Section\n```\n"))
      .rejects.toThrow("missing sections: Real Section");
    await expect(validateTemplateCompliance(paths, "fenced", "## Real Section\n"))
      .resolves.toBeUndefined();
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
    expect(schema).toContain("13 tools");
    expect(schema).toContain("`wiki_schema_create` creates a new custom template directly");
    expect(schema).toContain("schema/template-{id}.md");
    expect(schema).toContain("patch approval enforce selected template body sections");
    expect(schemaAgents).toContain("Treat `rawSourceRef` as current latest-provenance metadata.");
    expect(doctrine).toContain("already-pending queue proposal revisions may use host-only `wiki_patch_edit`");
    expect(doctrine).toContain("Read-only consult: `wiki_orient` · `wiki_briefing` · `wiki_read` · `wiki_resolve`");
    expect(doctrine).toContain("host-only `wiki_ingest`");
    expect(doctrine).toContain("`wiki_schema_list` / `wiki_schema_read` / `wiki_schema_create`");
    expect(doctrine).toContain("The host performs every Fleet Wiki operation directly.");
    expect(doctrine).not.toContain("Chronicle");
    expect(doctrine).not.toContain("Sub-agents **propose**; the Admiral **commits**.");
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
