import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  AcpModelUnavailableError,
  createAgyAcpSessionPort,
  type AcpSession,
  type AcpSessionEvent,
} from "../../src/acp/index.js";

const fakeAgy = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-agy.mjs");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness(models?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-acp-test-"));
  roots.push(root);
  const log = path.join(root, "fake.log");
  const sessionsDir = path.join(root, "sessions");
  const port = createAgyAcpSessionPort({
    sessionsDir,
    command: process.execPath,
    commandArgs: [fakeAgy],
    env: { ...process.env, FAKE_LOG: log, ...(models ? { FAKE_MODELS: models } : {}) },
  });
  const read = async () => (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  return { port, sessionsDir, read };
}

const open = (port: ReturnType<typeof createAgyAcpSessionPort>, model: string) => port.open({
  model,
  cwd: os.tmpdir(),
  systemPrompt: "be brief",
  mcpServers: [{ name: "fleet", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer t" } }],
});

describe("agy ACP session port", () => {
  it("opens a Fleet-scoped session, normalizes one turn, and removes the session directory on close", async () => {
    const { port, sessionsDir, read } = await harness();
    let session: AcpSession | undefined;
    try {
      session = await open(port, "antigravity--gemini-4-argon");
      const events: AcpSessionEvent[] = [];
      for await (const event of session.prompt([{ kind: "text", text: "hi" }])) events.push(event);
      expect(events).toEqual([
        { kind: "thought", text: "thinking" },
        { kind: "tool-start", id: "t1", name: "mcp_fleet_ping", input: { a: 1 } },
        { kind: "tool-end", id: "t1", isError: false },
        { kind: "text", text: "hel" },
        { kind: "text", text: "lo" },
        { kind: "usage", usage: { usedTokens: 42, contextWindow: 1048576 } },
        { kind: "turn-end", stopReason: "end_turn" },
      ]);
      const log = await read();
      const argv = log[0]?.argv as string[];
      // The session is pinned to Fleet's own gemini-dir, never the person's default, and never resumes.
      expect(argv.slice(0, 5)).toEqual(["acp", "--gemini-dir", expect.stringContaining(sessionsDir), "--app-data-dir", "fleet-agy"]);
      expect(log.some((entry) => entry.method === "session/load" || entry.method === "session/resume")).toBe(false);
      const created = log.find((entry) => entry.method === "session/new")?.params as Record<string, unknown>;
      expect(created.mcpServers).toEqual([
        { type: "http", name: "fleet", url: "http://127.0.0.1:1/mcp", headers: [{ name: "Authorization", value: "Bearer t" }] },
      ]);
      expect(created._meta).toEqual({ antigravity: { systemPrompt: { append: "be brief" } } });
      const configured = log.filter((entry) => entry.method === "session/set_config_option").map((entry) => entry.params);
      expect(configured).toEqual([
        { sessionId: "s1", configId: "model", value: "gemini-4-argon" },
        { sessionId: "s1", configId: "thought_level", value: "high" },
      ]);
      expect(await readdir(sessionsDir)).toHaveLength(1);
    } finally {
      await session?.close();
    }
    expect(await readdir(sessionsDir)).toEqual([]);
  });

  it("fails the open at once when the account does not offer the chosen model", async () => {
    const { port, sessionsDir } = await harness("gemini-4-carbon-low,gemini-4-carbon-medium,gemini-4-carbon-high");
    const failure = await open(port, "antigravity--gemini-4-argon").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AcpModelUnavailableError);
    expect((failure as AcpModelUnavailableError).availableModels).toContain("gemini-4-carbon-medium");
    expect(await readdir(sessionsDir)).toEqual([]);
  });
});
