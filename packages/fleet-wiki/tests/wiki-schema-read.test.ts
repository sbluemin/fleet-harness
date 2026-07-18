import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryPaths, ensureMemoryRoot } from "../src/paths.js";
import { readSchemaCatalog, readSchemaDocument } from "../src/schema.js";

describe("schema catalog reads", () => {
  it("returns logical refs and full documents", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wiki-schema-read-"));
    try {
      const paths = createMemoryPaths(path.join(root, "knowledge")); await ensureMemoryRoot(paths);
      const catalog = await readSchemaCatalog(paths);
      expect(catalog.schema.ref).toBe("schema/wiki-schema.md");
      expect(catalog.templates).toContainEqual(expect.objectContaining({ id: "prd", ref: "schema/template-prd.md" }));
      expect((await readSchemaDocument(paths, "template", "prd")).content).toContain("template_id: prd");
      expect(JSON.stringify(catalog)).not.toContain(paths.root);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects a symlinked catalog schema without reading its target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wiki-schema-symlink-"));
    try {
      const paths = createMemoryPaths(path.join(root, "knowledge")); await ensureMemoryRoot(paths);
      const secretPath = path.join(root, "secret.md");
      await writeFile(secretPath, "SECRET_SCHEMA_LEAK", "utf8");
      await rm(path.join(paths.schemaDir, "wiki-schema.md"));
      await symlink(secretPath, path.join(paths.schemaDir, "wiki-schema.md"));

      await expect(readSchemaCatalog(paths)).rejects.toThrow("schema resource path contains symlink");
      await expect(readSchemaCatalog(paths)).rejects.not.toThrow("SECRET_SCHEMA_LEAK");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
