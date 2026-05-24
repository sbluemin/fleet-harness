import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";

import { startFleetWikiServer } from "../src/server.js";

let server: Server | null = null;
let tempDir = "";
let baseUrl = "";
let lockPath = "";
let lockToken = "";

describe("daemon workspaces", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-ui-daemon-"));
    await createKnowledgeRoot(tempDir);
    lockPath = path.join(tempDir, "daemon.lock");
    server = await startFleetWikiServer({ cwd: tempDir, lockPath, port: 0, host: "127.0.0.1" });
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as { port: number; token: string };
    baseUrl = `http://127.0.0.1:${lock.port}`;
    lockToken = lock.token;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("keeps lockfile payload runtime-only", async () => {
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
    expect(Object.keys(lock).sort()).toEqual(["host", "pid", "port", "startedAt", "token"]);
    expect(lock.host).toBe("127.0.0.1");
    expect(typeof lock.token).toBe("string");
    expect((lock.token as string).length).toBeGreaterThan(20);
    expect(lock).not.toHaveProperty("cwd");
    expect(lock).not.toHaveProperty("paths");
    expect(lock).not.toHaveProperty("label");
    expect(lock).not.toHaveProperty("workspaces");
  });

  it("requires bearer auth for admin workspace registration", async () => {
    const response = await fetch(`${baseUrl}/api/admin/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: tempDir }),
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "unauthorized" });
  });

  it("registers a second workspace and updates the memory-backed MRU list", async () => {
    const second = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-ui-daemon-second-"));
    await createKnowledgeRoot(second);
    try {
      const registerResponse = await fetch(`${baseUrl}/api/admin/workspaces`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${lockToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ cwd: second }),
      });
      expect(registerResponse.status).toBe(200);
      const registered = await registerResponse.json() as { workspace: { id: string; label: string; urlPath: string } };
      expect(registered.workspace.id).toMatch(/^[a-f0-9]{12}$/);
      expect(registered.workspace.label).toBe(path.basename(second));
      expect(registered.workspace.urlPath).toBe(`/w/${registered.workspace.id}/`);

      const listResponse = await fetch(`${baseUrl}/api/workspaces`);
      expect(listResponse.status).toBe(200);
      const list = await listResponse.json() as { currentWorkspaceId: string; workspaces: Array<{ id: string }> };
      expect(list.currentWorkspaceId).toBe(registered.workspace.id);
      expect(list.workspaces.map((item) => item.id)).toContain(registered.workspace.id);
      expect(list.workspaces).toHaveLength(2);
    } finally {
      await rm(second, { recursive: true, force: true });
    }
  });

  it("rejects admin registration for directories without .fleet/knowledge", async () => {
    const missing = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-ui-daemon-missing-"));
    try {
      const response = await fetch(`${baseUrl}/api/admin/workspaces`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${lockToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ cwd: missing }),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "knowledge_root_missing" });
    } finally {
      await rm(missing, { recursive: true, force: true });
    }
  });
});

async function createKnowledgeRoot(cwd: string): Promise<void> {
  await mkdir(path.join(cwd, ".fleet", "knowledge", "wiki"), { recursive: true });
  await mkdir(path.join(cwd, ".fleet", "knowledge", "raw"), { recursive: true });
}
