import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryPaths, ensureMemoryRoot } from "../src/paths.js";
import { createSchemaTemplate, validateSchemaTemplateCreate } from "../src/schema.js";

describe("schema template creation", () => {
  it("creates a valid custom template directly and exclusively", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wiki-schema-create-"));
    try {
      const paths = createMemoryPaths(path.join(root, "knowledge"));
      const markdown = "---\ntemplate_id: incident\n---\n## Summary\n";

      await expect(createSchemaTemplate(paths, "incident", markdown)).resolves.toEqual({
        ref: "schema/template-incident.md",
        content: markdown,
      });
      expect(await readFile(path.join(paths.schemaDir, "template-incident.md"), "utf8")).toBe(markdown);
      await expect(createSchemaTemplate(paths, "incident", markdown)).rejects.toThrow("already exists");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid IDs, UTF-8 oversize, malformed templates, and duplicate sections", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wiki-schema-invalid-"));
    try {
      const paths = createMemoryPaths(path.join(root, "knowledge"));
      await ensureMemoryRoot(paths);
      await expect(validateSchemaTemplateCreate(paths, "../bad", "---\ntemplate_id: ../bad\n---\n## Summary\n")).rejects.toThrow("template_id must match");
      await expect(validateSchemaTemplateCreate(paths, "large", "---\ntemplate_id: large\n---\n## Summary\n" + "x".repeat(256 * 1024))).rejects.toThrow("256 KiB");
      await expect(validateSchemaTemplateCreate(paths, "malformed", "template_id: malformed\n## Summary\n")).rejects.toThrow("frontmatter is malformed");
      await expect(validateSchemaTemplateCreate(paths, "duplicate", "---\ntemplate_id: duplicate\n---\n## Same\n## same\n")).rejects.toThrow("duplicate");
      await expect(validateSchemaTemplateCreate(paths, "fenced", "---\ntemplate_id: fenced\n---\n```md\n## Not a section\n```\n")).rejects.toThrow("at least one ## section");
      await expect(validateSchemaTemplateCreate(paths, "fenced-nbsp", "---\ntemplate_id: fenced-nbsp\n---\n```md\n```\u00a0\n## Still fenced\n")).rejects.toThrow("at least one ## section");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked destination without reading or overwriting its target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wiki-schema-create-symlink-"));
    try {
      const paths = createMemoryPaths(path.join(root, "knowledge"));
      await ensureMemoryRoot(paths);
      const secret = path.join(root, "secret.md");
      await writeFile(secret, "KEEP", "utf8");
      await symlink(secret, path.join(paths.schemaDir, "template-linked.md"));

      await expect(createSchemaTemplate(paths, "linked", "---\ntemplate_id: linked\n---\n## Summary\n")).rejects.toThrow(/symlink|already exists/);
      expect(await readFile(secret, "utf8")).toBe("KEEP");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
