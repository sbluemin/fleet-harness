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
});
