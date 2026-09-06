import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendLog, createMemoryPaths } from "@dotobokuri/fleet-wiki";
import { handleApiRequest } from "../server/codex/routes.js";

describe("Codex schema API", () => {
  let root = "";
  let paths: ReturnType<typeof createMemoryPaths>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "codex-schema-api-"));
    paths = createMemoryPaths(path.join(root, ".fleet", "knowledge"));
    await mkdir(paths.schemaDir, { recursive: true });
    await writeFile(path.join(paths.schemaDir, "wiki-schema.md"), "# Workspace schema\n## Rules\n", "utf8");
    await writeFile(path.join(paths.schemaDir, "template-prd.md"), "---\ntemplate_id: prd\n---\n## Summary\n", "utf8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns a path-free catalog and full schema/template documents", async () => {
    const catalog = await get("/api/schema");
    expect(catalog.status).toBe(200);
    expect(catalog.body).toContain("schema/wiki-schema.md");
    expect(catalog.body).toContain("schema/template-prd.md");
    expect(catalog.body).not.toContain(root);
    expect((await get("/api/schema/wiki-schema")).body).toContain("## Rules");
    expect((await get("/api/schema/templates/prd")).body).toContain("## Summary");
  });

  it("bootstraps schema catalog and documents for an uninitialized Theater", async () => {
    await rm(paths.root, { recursive: true, force: true });

    const catalog = await get("/api/schema");
    expect(catalog.status).toBe(200);
    expect(catalog.body).toContain("schema/wiki-schema.md");
    expect(catalog.body).toContain("schema/template-prd.md");

    const schema = await get("/api/schema/wiki-schema");
    expect(schema.status).toBe(200);
    expect(schema.body).toContain("# Fleet Wiki Workspace Schema");

    const template = await get("/api/schema/templates/prd");
    expect(template.status).toBe(200);
    expect(template.body).toContain("template_id: prd");
  });

  async function get(url: string): Promise<{ status: number; body: string }> {
    const result = { status: 0, body: "" };
    const request = { method: "GET", url, headers: {} } as unknown as IncomingMessage;
    const response = {
      writeHead(status: number) { result.status = status; return this; },
      end(body?: string) { result.body = body ?? ""; return this; },
    } as unknown as ServerResponse;
    await handleApiRequest(request, response, {
      cwd: root,
      knowledgeRoot: paths.root,
      paths,
      port: 0,
      host: "127.0.0.1",
      workspaceId: "test",
      allowedOrigins: new Set(),
      externalMode: false,
      admitted: true,
    });
    return result;
  }
});
