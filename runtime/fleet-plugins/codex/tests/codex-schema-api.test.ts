import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendLog, createMemoryPaths } from "@dotobokuri/fleet-wiki";
import { handleApiRequest } from "../core/host/codex/routes.js";

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

  it("maps missing and invalid schema resources to stable GET errors", async () => {
    await unlink(path.join(paths.schemaDir, "wiki-schema.md"));
    expect(await get("/api/schema/wiki-schema")).toEqual({ status: 404, body: '{"error":"schema_not_found"}' });
    expect(await get(`/api/schema/templates/${encodeURIComponent("../bad")}`)).toEqual({ status: 400, body: '{"error":"invalid_template_id"}' });
    expect(await get("/api/schema/templates/missing")).toEqual({ status: 404, body: '{"error":"template_not_found"}' });
  });

  it("marks a malformed wiki log as unreadable without hiding other counts", async () => {
    await mkdir(paths.root, { recursive: true });
    await writeFile(path.join(paths.root, "log.md"), "## 2026-08-04T00:00:00.000Z — future event\n\n", "utf8");

    const response = await get("/api/health");

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      lastDrydock: null,
      conflictCount: 0,
      pendingCount: 0,
      logUnreadable: true,
    });
  });

  it("reports the latest drydock and open workspace queue counts", async () => {
    await mkdir(path.join(paths.queueDir, "2026-08-03T01-02-03-004Z-1234abcd"), { recursive: true });
    await writeFile(path.join(paths.queueDir, "2026-08-03T01-02-03-004Z-1234abcd", "meta.json"), JSON.stringify({
      id: "2026-08-03T01-02-03-004Z-1234abcd",
      status: "pending",
      createdAt: "2026-08-03T01:02:03.004Z",
    }), "utf8");
    await mkdir(path.join(paths.conflictsDir, "open-conflict"), { recursive: true });
    await writeFile(path.join(paths.conflictsDir, "open-conflict", "meta.json"), JSON.stringify({ status: "unresolved", createdAt: "2026-08-03T00:00:00.000Z" }), "utf8");
    await mkdir(path.join(paths.conflictsDir, "resolved-conflict"), { recursive: true });
    await writeFile(path.join(paths.conflictsDir, "resolved-conflict", "meta.json"), JSON.stringify({ status: "resolved", createdAt: "2026-08-02T00:00:00.000Z" }), "utf8");
    await appendLog(paths, "drydock run", {
      ok: false,
      error_count: 2,
      warning_count: 3,
      info_count: 1,
      issue_count: 6,
    }, new Date("2026-08-03T02:03:04.000Z"));

    const response = await get("/api/health");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      lastDrydock: {
        at: "2026-08-03T02:03:04.000Z",
        ok: false,
        errorCount: 2,
        warningCount: 3,
        infoCount: 1,
        issueCount: 6,
      },
      conflictCount: 1,
      pendingCount: 1,
    });
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
