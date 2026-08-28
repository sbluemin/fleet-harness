import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CONTENT_SECURITY_POLICY } from "../core/host/codex/contracts.js";
import { startCodexTestServer } from "./codex-test-server.js";
import type { CodexTestServer } from "./codex-test-server.js";

let server: CodexTestServer | null = null;
let baseUrl = "";
let tempDir = "";

describe("security headers", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "fleet-console-codex-headers-"));
    const wikiDir = path.join(tempDir, ".fleet", "knowledge", "wiki");
    const rawDir = path.join(tempDir, ".fleet", "knowledge", "raw");
    await mkdir(wikiDir, { recursive: true });
    await mkdir(rawDir, { recursive: true });
    await writeFile(path.join(rawDir, "sample.md"), "raw body", "utf8");
    await writeFile(
      path.join(wikiDir, "alpha.md"),
      [
        "---",
        'id: "alpha"',
        'title: "Alpha"',
        "tags: []",
        'created: "2026-05-05T00:00:00.000Z"',
        'updated: "2026-05-05T00:00:00.000Z"',
        "version: 1",
        "---",
        "alpha body",
      ].join("\n"),
      "utf8",
    );
    const lockPath = path.join(tempDir, "server.lock");
    server = await startCodexTestServer({ cwd: tempDir, lockPath, port: 0, host: "127.0.0.1" });
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as { port: number };
    baseUrl = `http://127.0.0.1:${lock.port}/console/codex`;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("applies exact security headers to static, spa, api, markdown, and error responses", async () => {
    const indexResponse = await fetch(`${baseUrl}/`);
    const healthResponse = await fetch(`${baseUrl}/api/health`);
    const rawResponse = await fetch(`${baseUrl}/api/raw?ref=${encodeURIComponent("raw/sample.md")}`);
    const notFoundResponse = await fetch(`${baseUrl}/api/does-not-exist`);
    const spaFallbackResponse = await fetch(`${baseUrl}/entry/alpha`);

    for (const response of [healthResponse, rawResponse, notFoundResponse]) {
      expect(response.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }

    for (const response of [indexResponse, spaFallbackResponse]) {
      const policy = response.headers.get("content-security-policy") ?? "";
      expect(policy).toContain("default-src 'self'");
      expect(policy).toContain("object-src 'none'");
      expect(policy).toContain("base-uri 'none'");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
});
