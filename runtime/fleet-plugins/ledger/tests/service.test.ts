import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { OperationNode } from "@fleet-console/sdk/operations";
import { describe, expect, it, vi } from "vitest";

import { createLedgerService } from "../server/service.js";

const fixture = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "tokscale-report.json"), "utf8");

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
  it("runs only the device-wide local report command with no workspace filter", async () => {
    const executor = vi.fn(async () => ({ stdout: "[]", stderr: "progress", exitCode: 0 }));
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
    expect(executor.mock.calls.flat().join(" ")).not.toContain("--workspace");
    expect(result.source.status).toBe("ok");
    expect(executor.mock.calls.flat().join(" ")).not.toMatch(/\b(login|logout|submit|autosubmit|whoami|delete-submitted-data)\b/);
  });

  it("reuses one window report across scopes and reapplies the Operation theater filter", async () => {
    const executor = vi.fn(async () => ({ stdout: fixture, stderr: "", exitCode: 0 }));
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

    expect(executor).toHaveBeenCalledTimes(1);
    expect(scoped.operations.map((entry) => entry.operationId)).toEqual(["claude-a"]);
    expect(all.operations.map((entry) => entry.operationId).sort()).toEqual(["claude-a", "codex-b"]);
  });

  it("expires cache entries exactly at the TTL boundary", async () => {
    let now = 0;
    const executor = vi.fn(async () => ({ stdout: "[]", stderr: "", exitCode: 0 }));
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
    expect(executor).toHaveBeenCalledTimes(1);
    now = 15_000;
    await service.getSummary(request);
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("refresh bypasses cache but shares an existing in-flight report", async () => {
    let resolveExecutor!: (value: { stdout: string; stderr: string; exitCode: number }) => void;
    let executorCalls = 0;
    const executor = vi.fn(() => {
      executorCalls += 1;
      if (executorCalls > 1) return Promise.resolve({ stdout: "[]", stderr: "", exitCode: 0 });
      return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
        resolveExecutor = resolve;
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
    await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(1));
    resolveExecutor({ stdout: "[]", stderr: "", exitCode: 0 });
    await expect(Promise.all([first, refreshed])).resolves.toHaveLength(2);
    await service.getSummary({ ...request, refresh: true });
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent requests for the same window into one executor", async () => {
    let resolveExecutor!: (value: { stdout: string; stderr: string; exitCode: number }) => void;
    const executor = vi.fn(() => new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      resolveExecutor = resolve;
    }));
    const service = createLedgerService({
      cliHome: "/plugin/cli",
      executor,
      isInstalled: async () => true,
    });
    const request = { theaterId: null, window: "month" as const, refresh: false, operations: [] };
    const first = service.getSummary(request);
    const second = service.getSummary(request);
    await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(1));
    resolveExecutor({ stdout: "[]", stderr: "", exitCode: 0 });
    await Promise.all([first, second]);
    expect(executor).toHaveBeenCalledTimes(1);
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
    const executor = vi.fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 })
      .mockResolvedValueOnce({ stdout: "{broken", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: JSON.stringify(partial), stderr: "", exitCode: 0 });
    const service = createLedgerService({
      cliHome: "/plugin/cli",
      executor,
      isInstalled: async () => true,
    });
    const base = { theaterId: null, refresh: false, operations: [] };
    expect((await service.getSummary({ ...base, window: "today" })).source.status).toBe("unavailable");
    expect((await service.getSummary({ ...base, window: "week" })).source.status).toBe("unreadable");
    const degraded = await service.getSummary({ ...base, window: "month" });
    expect(degraded.source).toMatchObject({ status: "degraded", skippedSessions: 1 });
  });
});
