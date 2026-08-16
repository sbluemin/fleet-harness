import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { createLedgerService } from "../server/service.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const reportFixture = fs.readFileSync(path.join(fixturesDir, "tokscale-report.json"), "utf8");
const modelsFixture = fs.readFileSync(path.join(fixturesDir, "tokscale-models.json"), "utf8");
const EMPTY_MODELS = JSON.stringify({ groupBy: "client,session,model", entries: [] });
const commandResult = (stdout: string, exitCode = 0) => ({ stdout, stderr: "", exitCode });

function executorFor(report = reportFixture, models = modelsFixture) {
  return vi.fn(async (args: readonly string[]) => (
    args[0] === "models" ? commandResult(models) : commandResult(report)
  ));
}

describe("Ledger service command contract", () => {
  it("runs Claude Code report and session-model ledger commands in parallel with exact filters", async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const executor = vi.fn(async (args: readonly string[]) => {
      started += 1;
      if (started === 2) release();
      await gate;
      return commandResult(args[0] === "models" ? EMPTY_MODELS : "[]");
    });
    const service = createLedgerService({
      cliHome: "/plugin/cli",
      executor,
      isInstalled: async () => true,
      now: () => 123,
    });

    const pending = service.getSummary({ window: "today", refresh: false });
    await vi.waitFor(() => expect(started).toBe(2));
    await pending;

    expect(executor).toHaveBeenCalledWith(
      ["report", "--json", "--no-summarize", "--client", "claude", "--today"],
      expect.objectContaining({ cwd: os.homedir(), timeout: 60_000 }),
    );
    expect(executor).toHaveBeenCalledWith(
      ["models", "--json", "--no-spinner", "-c", "claude", "--group-by", "client,session,model", "--today"],
      expect.objectContaining({ cwd: os.homedir(), timeout: 60_000 }),
    );
    const invoked = executor.mock.calls.flat().join(" ");
    expect(invoked).not.toContain("--workspace");
    expect(invoked).not.toMatch(/\b(login|logout|submit|autosubmit|whoami|delete-submitted-data)\b/);
  });

  it("builds cost from every Claude Code model row rather than report total_cost", async () => {
    const executor = executorFor();
    const service = createLedgerService({
      cliHome: "/plugin/cli",
      executor,
      isInstalled: async () => true,
      now: () => 1_750_000_300_000,
    });
    const result = await service.getSummary({ window: "today", refresh: false });
    expect(result.totals.costUsd).toBe(1.250108);
    expect(result.modelRows.map((row) => ({ modelId: row.modelId, provider: row.provider }))).toEqual([
      { modelId: "claude-opus-5", provider: "anthropic" },
      { modelId: "claude-gateway--cursor--claude-opus-5", provider: "cursor" },
      { modelId: "claude-gateway--xai--grok-4.6", provider: "xai" },
    ]);
    expect(result.daily).toEqual([{ day: expect.any(String), costUsd: 1.2501 }]);
    expect(result.source).toMatchObject({ models: "ok", report: "degraded" });
  });
});

describe("Ledger service cache and concurrency", () => {
  it("expires cache entries exactly at the 15-second TTL boundary", async () => {
    let now = 0;
    const executor = executorFor("[]", EMPTY_MODELS);
    const service = createLedgerService({ cliHome: "/plugin/cli", executor, isInstalled: async () => true, now: () => now });
    const request = { window: "week" as const, refresh: false };
    await service.getSummary(request);
    now = 14_999;
    await service.getSummary(request);
    expect(executor).toHaveBeenCalledTimes(2);
    now = 15_000;
    await service.getSummary(request);
    expect(executor).toHaveBeenCalledTimes(4);
  });

  it("coalesces concurrent requests for the same window into one report-and-model pair", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const executor = vi.fn(async (args: readonly string[]) => {
      await gate;
      return commandResult(args[0] === "models" ? EMPTY_MODELS : "[]");
    });
    const service = createLedgerService({ cliHome: "/plugin/cli", executor, isInstalled: async () => true });
    const request = { window: "month" as const, refresh: false };
    const first = service.getSummary(request);
    const second = service.getSummary(request);
    await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(2));
    release();
    await Promise.all([first, second]);
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("refresh bypasses cache but shares an already-running window pair", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let blocked = true;
    const executor = vi.fn(async (args: readonly string[]) => {
      if (blocked) await gate;
      return commandResult(args[0] === "models" ? EMPTY_MODELS : "[]");
    });
    const service = createLedgerService({ cliHome: "/plugin/cli", executor, isInstalled: async () => true });
    const first = service.getSummary({ window: "week", refresh: false });
    const refreshed = service.getSummary({ window: "week", refresh: true });
    await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(2));
    blocked = false;
    release();
    await Promise.all([first, refreshed]);
    await service.getSummary({ window: "week", refresh: true });
    expect(executor).toHaveBeenCalledTimes(4);
  });

  it("keeps separate cache and in-flight pairs per window", async () => {
    const executor = executorFor("[]", EMPTY_MODELS);
    const service = createLedgerService({ cliHome: "/plugin/cli", executor, isInstalled: async () => true });
    await Promise.all([
      service.getSummary({ window: "today", refresh: false }),
      service.getSummary({ window: "week", refresh: false }),
    ]);
    expect(executor).toHaveBeenCalledTimes(4);
    expect(executor.mock.calls.flatMap(([args]) => args).filter((value) => value === "--today")).toHaveLength(2);
    expect(executor.mock.calls.flatMap(([args]) => args).filter((value) => value === "--week")).toHaveLength(2);
  });
});

describe("Ledger service source failures", () => {
  it("does not cache bootstrap failure and retries on the next request", async () => {
    const bootstrap = vi.fn(async () => { throw new Error("temporary install failure"); });
    const service = createLedgerService({
      cliHome: "/plugin/cli",
      executor: vi.fn(),
      isInstalled: async () => false,
      bootstrap,
    });
    const request = { window: "week" as const, refresh: false };
    expect((await service.getSummary(request)).source.status).toBe("bootstrapping");
    await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await service.getSummary(request)).source.status).toBe("bootstrapping");
    await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(2));
  });

  it("keeps model totals but removes daily detail when report metadata fails", async () => {
    const executor = vi.fn(async (args: readonly string[]) => (
      args[0] === "models" ? commandResult(modelsFixture) : commandResult("", 1)
    ));
    const service = createLedgerService({ cliHome: "/plugin/cli", executor, isInstalled: async () => true, now: () => 123 });
    const result = await service.getSummary({ window: "week", refresh: false });
    expect(result.totals.costUsd).toBe(1.250108);
    expect(result.modelRows).toHaveLength(3);
    expect(result.daily).toEqual([]);
    expect(result.source).toMatchObject({ status: "degraded", models: "ok", report: "unavailable" });
  });

  it.each([
    ["unavailable", "", 1],
    ["unreadable", "{broken", 0],
  ] as const)("fails closed when the canonical model ledger is %s", async (status, stdout, exitCode) => {
    const executor = vi.fn(async (args: readonly string[]) => (
      args[0] === "models" ? commandResult(stdout, exitCode) : commandResult(reportFixture)
    ));
    const service = createLedgerService({ cliHome: "/plugin/cli", executor, isInstalled: async () => true, now: () => 123 });
    const result = await service.getSummary({ window: "week", refresh: false });
    expect(result.totals.costUsd).toBe(0);
    expect(result.modelRows).toEqual([]);
    expect(result.daily).toEqual([]);
    expect(result.source).toMatchObject({ status, models: status });
  });

  it("retains valid rows and reports parser degradation from either source", async () => {
    const report = JSON.stringify([
      { session_id: "30bf2ab7-5a5d-4a8c-8aaa-730a40ecf103", last_active: 1_750_000_300_000 },
      { session_id: "bad", last_active: 1_750_000_300_000 },
    ]);
    const models = JSON.stringify({
      entries: [
        { client: "claude", sessionId: "30bf2ab7-5a5d-4a8c-8aaa-730a40ecf103", model: "claude-opus-5", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 2, messageCount: 1 },
        { client: "codex", sessionId: "30bf2ab7-5a5d-4a8c-8aaa-730a40ecf103", model: "gpt-5", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 3, messageCount: 1 },
      ],
    });
    const service = createLedgerService({ cliHome: "/plugin/cli", executor: executorFor(report, models), isInstalled: async () => true, now: () => 1_750_000_300_000 });
    const result = await service.getSummary({ window: "today", refresh: false });
    expect(result.totals.costUsd).toBe(2);
    expect(result.source).toEqual({
      status: "degraded",
      models: "degraded",
      report: "degraded",
      skippedEntries: 1,
      skippedSessions: 1,
    });
  });
});
