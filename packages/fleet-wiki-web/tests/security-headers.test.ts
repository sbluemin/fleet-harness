import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";

import { startFleetWikiServer } from "../src/server.js";
import { CONTENT_SECURITY_POLICY } from "../src/security-headers.js";

let server: Server | null = null;
let baseUrl = "";
let tempDir = "";

describe("security headers", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-web-headers-"));
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
    server = await startFleetWikiServer({ cwd: tempDir, lockPath, port: 0 });
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as { port: number };
    baseUrl = `http://127.0.0.1:${lock.port}`;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("applies exact security headers to static, spa, api, markdown, and error responses", async () => {
    const indexResponse = await fetch(`${baseUrl}/`);
    const indexHtml = await indexResponse.text();
    const scriptPath = extractAssetPath(indexHtml, ".js");
    const stylePath = extractAssetPath(indexHtml, ".css");
    const scriptResponse = await fetch(`${baseUrl}${scriptPath}`);
    const styleResponse = await fetch(`${baseUrl}${stylePath}`);
    const fontPath = extractFontPath(await styleResponse.clone().text());
    const fontResponse = await fetch(`${baseUrl}${fontPath}`);
    const healthResponse = await fetch(`${baseUrl}/api/health`);
    const rawResponse = await fetch(`${baseUrl}/api/raw?ref=${encodeURIComponent("raw/sample.md")}`);
    const notFoundResponse = await fetch(`${baseUrl}/api/does-not-exist`);
    const spaFallbackResponse = await fetch(`${baseUrl}/entry/alpha`);

    for (const response of [indexResponse, scriptResponse, styleResponse, fontResponse, healthResponse, rawResponse, notFoundResponse, spaFallbackResponse]) {
      expect(response.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
});

function extractAssetPath(html: string, extension: ".js" | ".css"): string {
  const regex = extension === ".js"
    ? /\/assets\/[A-Za-z0-9._-]+\.js\b/
    : /\/assets\/[A-Za-z0-9._-]+\.css\b/;
  const match = html.match(regex);
  if (!match?.[0]) {
    throw new Error(`missing ${extension} asset in index.html`);
  }
  return match[0];
}

function extractFontPath(css: string): string {
  const match = css.match(/url\(([^)]+\.woff2)\)/);
  if (!match?.[1]) {
    throw new Error("missing woff2 asset in css");
  }
  return match[1].replace(/^['"]|['"]$/g, "");
}
