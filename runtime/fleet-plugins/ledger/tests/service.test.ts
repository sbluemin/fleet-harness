import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { OperationNode } from "@fleet-console/sdk/operations";
import { describe, expect, it, vi } from "vitest";

import { createLedgerService } from "../server/service.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = fs.readFileSync(path.join(fixturesDir, "tokscale-report.json"), "utf8");
const EMPTY_MODELS = JSON.stringify({
  groupBy: "model",
  entries: [],
  totalCost: 0,
  totalMessages: 0,
  totalInput: 0,
  totalOutput: 0,
  totalCacheRead: 0,
  totalCacheWrite: 0,
});

function executorFor(report: { stdout: string; stderr?: string; exitCode?: number }) {
  return vi.fn(async (args: readonly string[]) => {
    if (args[0] === "models") return { stdout: EMPTY_MODELS, stderr: "", exitCode: 0 };
    return { stdout: report.stdout, stderr: report.stderr ?? "", exitCode: report.exitCode ?? 0 };
  });
}

function operation(
  id: string,
  theaterId: string,
  provider: "claude" | "codex",
  sessionId: string,
): OperationNode {
  return {
    id,
    theaterId,
    pluginId: "terminal",
    type: "agent",
    title: id,
    payload: {
      cliId: provider,
      cliLabel: provider,
      providerSession: { provider, sessionId },
    },
    geometry: null,
    ts: { createdAt: 1, updatedAt: 1 },
  };
}

describe("Ledger service command contract", () => {
  it("runs the device-wide report and models commands with no workspace filter", async () => {
    const executor = executorFor({ stdout: "[]", stderr: "progress" });
    const service = createLedgerService({
      cliHome: "/plugin/cli",
      executor,
      isInstalled: async () => true,
      now: () => 123,
    });
    const result = await service.getSummary({
      theaterId: "theater-a",
      window: "today",
      refresh: false,
      operations: [] as OperationNode[],
    });
    expect(executor).toHaveBeenCalledWith(
      ["report", "--json", "--no-summarize", "--today"],
      expect.objectContaining({ cwd: os.homedir(), timeout: 60_000 }),
    );
    expect(executor).toHaveBeenCalledWith(
      ["models", "--json", "--no-spinner", "--group-by", "model", "--today"],
      expect.objectContaining({ cwd: os.homedir(), timeout: 60_000 }),
    );
    expect(executor).toHaveBeenCalledTimes(2);
    const invoked = executor.mock.calls.flat().join(" ");
    expect(invoked).not.toContain("--workspace");
    expect(invoked).not.toContain("--hide-zero");
    expect(result.source.status).toBe("ok");
    expect(result.modelSource.status).toBe("ok");
    expect(invoked).not.toMatch(/\b(login|logout|submit|autosubmit|whoami|delete-submitted-data)\b/);
  });

  it("reuses one window report across scopes and reapplies the Operation theater filter", async () => {
    const executor = executorFor({ stdout: fixture });
    const service = createLedgerService({
      cliHome: "/plugin/cli",
      executor,
      isInstalled: async () => true,
      now: () => 123,
    });
    const operations = [
      operation("claude-a", "theater-a", "claude", "30bf2ab7-5a5d-4a8c-8aaa-730a40ecf103"),
      operation("codex-b", "theater-b", "codex", "019f9ab4-7d11-7000-8000-123456789abc"),
    ];

    const scoped = await service.getSummary({
      theaterId: "theater-a",
      window: "week",
      refresh: false,
      operations,
    });
    const all = await service.getSummary({
      theaterId: null,
      window: "week",
      refresh: false,
      operations,
    });

    expect(executor).toHaveBeenCalledTimes(2);
    expect(scoped.operations.map((entry) => entry.operationId)).toEqual(["claude-a"]);
    expect(all.operations.map((entry) => entry.operationId).sort()).toEqual(["claude-a", "codex-b"]);
  });

  it("expires cache entries exactly at the TTL boundary", async () => {
    let now = 0;
    const executor = executorFor({ stdout: "[]" });
    const service = createLedgerService({
      cliHome: "/plugin/cli",
      executor,
      isInstalled: async () => true,
      now: () => now,
    });
    const request = { theaterId: null, window: "week" as const, refresh: false, operations: [] };
    await service.getSummary(request);
    now = 14_999;
    await service.getSummary(request);
    expect(executor).toHaveBeenCalledTimes(2);
    now = 15_000;
    await service.getSummary(request);
    expect(executor).toHaveBeenCalledTimes(4);
  });

  it("refresh bypasses cache but shares an existing in-flight window pair", async () => {
    let resolveReport!: (value: { stdout: string; stderr: string; exitCode: number }) => void;
    let reportCalls = 0;
    const executor = vi.fn((args: readonly string[]) => {
      if (args[0] === "models") return Promise.resolve({ stdout: EMPTY_MODELS, stderr: "", exitCode: 0 });
      reportCalls += 1;
      if (reportCalls > 1) return Promise.resolve({ stdout: "[]", stderr: "", exitCode: 0 });
      return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
        resolveReport = resolve;
      });
    });
    const service = createLedgerService({
      cliHome: "/plugin/cli",
      executor,
      isInstalled: async () => true,
    });
    const request = { theaterId: null, window: "week" as const, operations: [] };
    const first = service.getSummary({ ...request, refresh: false });
    const refreshed = service.getSummary({ ...request, refresh: true });
    await vi.waitFor(() => expect(reportCalls).toBe(1));
    resolveReport({ stdout: "[]", stderr: "", exitCode: 0 });
    await expect(Promise.all([first, refreshed])).resolves.toHaveLength(2);
    await service.getSummary({ ...request, refresh: true });
    expect(reportCalls).toBe(2);
    expect(executor).toHaveBeenCalledTimes(4);
  });

  it("coalesces concurrent requests for the same window into one report-and-models pair", async () => {
    let resolveReport!: (value: { stdout: string; stderr: string; exitCode: number }) => void;
    const executor = vi.fn((args: readonly string[]) => {
      if (args[0] === "models") return Promise.resolve({ stdout: EMPTY_MODELS, stderr: "", exitCode: 0 });
      return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
        resolveReport = resolve;
      });
    });
    const service = createLedgerService({
      cliHome: "/plugin/cli",
      executor,
      isInstalled: async () => true,
    });
    const request = { theaterId: null, window: "month" as const, refresh: false, operations: [] };
    const first = service.getSummary(request);
    const second = service.getSummary(request);
    await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(2));
    resolveReport({ stdout: "[]", stderr: "", exitCode: 0 });
    await Promise.all([first, second]);
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("does not cache bootstrap failure and retries on the next request", async () => {
    const bootstrap = vi.fn(async () => {
      throw new Error("temporary install failure");
    });
    const service = createLedgerService({
      cliHome: "/plugin/cli",
      executor: vi.fn(),
      isInstalled: async () => false,
      bootstrap,
    });
    const request = { theaterId: null, window: "week" as const, refresh: false, operations: [] };
    expect((await service.getSummary(request)).source.status).toBe("bootstrapping");
    await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await service.getSummary(request)).source.status).toBe("bootstrapping");
    await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(2));
  });

  it("reports unavailable, unreadable, and degraded distinctly", async () => {
    const partial = JSON.parse(fixture) as Array<Record<string, unknown>>;
    delete partial[0]?.total_cost;
    const executor = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "models") return { stdout: EMPTY_MODELS, stderr: "", exitCode: 0 };
      if (args.includes("--today")) return { stdout: "", stderr: "", exitCode: 1 };
      if (args.includes("--week")) return { stdout: "{broken", stderr: "", exitCode: 0 };
      return { stdout: JSON.stringify(partial), stderr: "", exitCode: 0 };
    });
    const service = createLedgerService({
      cliHome: "/plugin/cli",
      executor,
      isInstalled: async () => true,
    });
    const base = { theaterId: null, refresh: false, operations: [] };
    const unavailable = await service.getSummary({ ...base, window: "today" });
    expect(unavailable.source.status).toBe("unavailable");
    expect(unavailable.modelSource.status).toBe("ok");
    expect((await service.getSummary({ ...base, window: "week" })).source.status).toBe("unreadable");
    const degraded = await service.getSummary({ ...base, window: "month" });
    expect(degraded.source).toMatchObject({ status: "degraded", skippedSessions: 1 });
  });

  it("keeps the report when the models command fails", async () => {
    const executor = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "models") return { stdout: "", stderr: "fail", exitCode: 1 };
      return { stdout: fixture, stderr: "", exitCode: 0 };
    });
    const service = createLedgerService({
      cliHome: "/plugin/cli",
      executor,
      isInstalled: async () => true,
    });
    const result = await service.getSummary({
      theaterId: null,
      window: "week",
      refresh: false,
      operations: [],
    });
    expect(result.source.status).toBe("ok");
    expect(result.deviceTotals.sessions).toBe(3);
    expect(result.modelSource.status).toBe("unavailable");
    expect(result.modelRows).toEqual([]);
    expect(result.suppliers).toEqual([]);
  });
});
