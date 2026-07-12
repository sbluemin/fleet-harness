import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeOneShot } from "@dotobokuri/core-agent";
import type { ExecResult, OneShotExecution, OneShotReady } from "@dotobokuri/core-agent";
import { getEffort, getProviderModels, type CliType, type ProtocolType } from "@dotobokuri/core-unified-agent";
import {
  createCarrierRuntime,
  initStore,
  getJobSummary,
  registerCarrier,
  resetJobCancelRegistryForTest,
  resetJobConcurrencyForTest,
  resetStoreForTests,
  updateTaskForceModelSelection,
  type CarrierConfig,
  type CarrierRuntime,
} from "../../src/index.js";

vi.mock("@dotobokuri/core-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dotobokuri/core-agent")>();
  return { ...actual, executeOneShot: vi.fn() };
});

const deps = { authEnvResolver: () => Promise.resolve({}) };

let tempDir: string | null = null;
let runtime: CarrierRuntime | null = null;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function protocolFor(cliType: CliType): ProtocolType {
  return cliType === "codex" ? "codex-app-server" : "acp";
}

function doneResult(sessionId: string): ExecResult {
  return { status: "done", responseText: "ok", thoughtText: "", toolCalls: [], sessionId };
}

function resolvedHandle(cliType: CliType, sessionId = `session-${cliType}`): OneShotExecution {
  const ready: OneShotReady = { cliType, protocol: protocolFor(cliType), sessionId };
  return {
    readiness: Promise.resolve(ready),
    completion: Promise.resolve(doneResult(sessionId)),
    startPrompt: vi.fn(),
    abort: vi.fn(async () => {}),
  };
}

function firstModel(cliType: CliType): string {
  const model = getProviderModels(cliType).models[0]?.modelId;
  if (!model) throw new Error(`No test model for ${cliType}`);
  return model;
}

function firstEffort(cliType: CliType, model: string): string | undefined {
  const effort = getEffort(cliType, model);
  return effort.supported ? effort.levels[0] : undefined;
}

function createConfig(id: string, displayName: string): CarrierConfig {
  return { id, displayName, slot: 1, defaultCliType: "claude", defaultModel: firstModel("claude") };
}

function configureTaskForce(carrierId: string): void {
  for (const cliType of ["claude", "codex"] as const) {
    const model = firstModel(cliType);
    updateTaskForceModelSelection(carrierId, cliType, { model, effort: firstEffort(cliType, model) });
  }
}

function details(result: unknown): { job_id: string; context_id?: string; accepted: boolean; error?: string } {
  return (result as { details: { job_id: string; context_id?: string; accepted: boolean; error?: string } }).details;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-oneshot-sessions-"));
  initStore(tempDir);
});

afterEach(async () => {
  await runtime?.cleanup();
  runtime = null;
  vi.mocked(executeOneShot).mockReset();
  resetJobConcurrencyForTest();
  resetJobCancelRegistryForTest();
  resetStoreForTests();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("single dispatch context resume", () => {
  it("rolls back a single dispatch when cleanup closes admission during baseline capture", async () => {
    runtime = createCarrierRuntime();
    registerCarrier(runtime.registry, createConfig("ohio", "Ohio"));
    const baseline = defer<readonly [] | null>();
    const handles: OneShotExecution[] = [];
    vi.mocked(executeOneShot).mockImplementation((opts) => {
      const cliType = opts.cliType as CliType;
      const completion = defer<ExecResult>();
      const handle: OneShotExecution = {
        readiness: Promise.resolve({ cliType, protocol: protocolFor(cliType), sessionId: `session-${cliType}` }),
        completion: completion.promise,
        startPrompt: vi.fn(),
        abort: vi.fn(async () => { completion.resolve({ ...doneResult(`session-${cliType}`), status: "aborted" }); }),
      };
      handles.push(handle);
      return handle;
    });
    const scanner = { snapshot: vi.fn(() => baseline.promise) };
    const tool = runtime.buildDispatchToolSpec({ ...deps, workspaceChangeScanner: scanner });

    const pending = tool.execute({ carrier_id: "ohio", label: "Cleanup race", request: "Do not open the prompt gate." }, { cwd: "/tmp", toolCallId: "single-cleanup-race" });
    await vi.waitFor(() => expect(scanner.snapshot).toHaveBeenCalledTimes(1));
    await runtime.cleanup();
    baseline.resolve([]);

    const result = await pending;
    expect(details(result)).toMatchObject({ accepted: false, error: "Carrier runtime is closed to new dispatches." });
    expect(handles).toHaveLength(1);
    expect(handles[0]!.startPrompt).not.toHaveBeenCalled();
    expect(handles[0]!.abort).toHaveBeenCalledTimes(1);
    expect(getJobSummary("carrier:single-cleanup-race", Date.now())).toBeNull();
  });

  it("returns and commits a fresh context_id when no resume_context_id is provided", async () => {
    runtime = createCarrierRuntime();
    registerCarrier(runtime.registry, createConfig("ohio", "Ohio"));
    vi.mocked(executeOneShot).mockImplementation((opts) => resolvedHandle(opts.cliType as CliType));
    const tool = runtime.buildDispatchToolSpec(deps);

    const result = await tool.execute({ carrier_id: "ohio", label: "Fresh", request: "Run once." }, { cwd: "/tmp", toolCallId: "u1" });

    await vi.waitFor(() => expect(executeOneShot).toHaveBeenCalledTimes(1));
    expect(vi.mocked(executeOneShot).mock.calls[0]![0].resumeSessionId).toBeUndefined();
    expect(details(result).context_id).toMatch(/^ctx:/);
    await vi.waitFor(() => expect(runtime!.dispatchContexts.size).toBe(1));
  });

  it("commits a mapping on a done turn and resumes it with the saved session id", async () => {
    runtime = createCarrierRuntime();
    registerCarrier(runtime.registry, createConfig("ohio", "Ohio"));
    vi.mocked(executeOneShot).mockImplementation((opts) => resolvedHandle(opts.cliType as CliType));
    const tool = runtime.buildDispatchToolSpec(deps);

    const first = await tool.execute({ carrier_id: "ohio", label: "First", request: "Run." }, { cwd: "/tmp", toolCallId: "c1" });
    const contextId = details(first).context_id;
    expect(contextId).toMatch(/^ctx:/);
    await vi.waitFor(() => expect(runtime!.dispatchContexts.size).toBe(1));

    const resumed = await tool.execute({ carrier_id: "ohio", label: "Resume", request: "Continue.", resume_context_id: contextId }, { cwd: "/tmp", toolCallId: "c2" });
    await vi.waitFor(() => expect(executeOneShot).toHaveBeenCalledTimes(2));

    expect(vi.mocked(executeOneShot).mock.calls[0]![0].resumeSessionId).toBeUndefined();
    expect(vi.mocked(executeOneShot).mock.calls[1]![0].resumeSessionId).toBe("session-claude");
    expect(details(resumed).context_id).toBe(contextId);
  });

  it("rejects a second in-flight dispatch that reuses the same resume_context_id", async () => {
    runtime = createCarrierRuntime();
    registerCarrier(runtime.registry, createConfig("ohio", "Ohio"));
    const pending = defer<ExecResult>();
    vi.mocked(executeOneShot).mockImplementationOnce((opts) => ({
      readiness: Promise.resolve({ cliType: opts.cliType as CliType, protocol: protocolFor(opts.cliType as CliType), sessionId: "s" }),
      completion: pending.promise,
      startPrompt: vi.fn(),
      abort: vi.fn(async () => {}),
    }));
    const tool = runtime.buildDispatchToolSpec(deps);

    const first = await tool.execute({ carrier_id: "ohio", label: "Hold", request: "Stay in flight." }, { cwd: "/tmp", toolCallId: "b1" });
    expect(details(first).accepted).toBe(true);
    const contextId = details(first).context_id;

    const second = await tool.execute({ carrier_id: "ohio", label: "Reuse", request: "Collide.", resume_context_id: contextId }, { cwd: "/tmp", toolCallId: "b2" });
    expect(details(second).accepted).toBe(false);
    expect(details(second).error).toContain("in flight");
    // Only the first call ever built a one-shot handle.
    expect(executeOneShot).toHaveBeenCalledTimes(1);

    pending.resolve(doneResult("s"));
  });

  it("rejects reuse against a different binding", async () => {
    runtime = createCarrierRuntime();
    registerCarrier(runtime.registry, createConfig("ohio", "Ohio"));
    vi.mocked(executeOneShot).mockImplementation((opts) => resolvedHandle(opts.cliType as CliType));
    const tool = runtime.buildDispatchToolSpec(deps);

    const first = await tool.execute({ carrier_id: "ohio", label: "Bind A", request: "Run.", cwd: "/abs/a" }, { cwd: "/host", toolCallId: "m1" });
    const contextId = details(first).context_id;
    await vi.waitFor(() => expect(runtime!.dispatchContexts.size).toBe(1));

    const mismatch = await tool.execute({ carrier_id: "ohio", label: "Bind B", request: "Run.", cwd: "/abs/b", resume_context_id: contextId }, { cwd: "/host", toolCallId: "m2" });
    expect(details(mismatch).accepted).toBe(false);
    expect(details(mismatch).error).toContain("different carrier");
  });

  it("rejects an invalid resume_context_id before building a handle", async () => {
    runtime = createCarrierRuntime();
    registerCarrier(runtime.registry, createConfig("ohio", "Ohio"));
    vi.mocked(executeOneShot).mockImplementation((opts) => resolvedHandle(opts.cliType as CliType));
    const tool = runtime.buildDispatchToolSpec(deps);

    const result = await tool.execute({ carrier_id: "ohio", label: "Bad id", request: "Run.", resume_context_id: " has space " }, { cwd: "/tmp", toolCallId: "bad" });
    expect(details(result).accepted).toBe(false);
    expect(details(result).error).toContain("Invalid resume_context_id");
    expect(executeOneShot).not.toHaveBeenCalled();
  });

  it("rejects an unknown resume_context_id instead of silently starting fresh", async () => {
    runtime = createCarrierRuntime();
    registerCarrier(runtime.registry, createConfig("ohio", "Ohio"));
    const tool = runtime.buildDispatchToolSpec(deps);

    const result = await tool.execute({ carrier_id: "ohio", label: "Missing", request: "Resume.", resume_context_id: "ctx:missing" }, { cwd: "/tmp", toolCallId: "missing" });

    expect(details(result).accepted).toBe(false);
    expect(details(result).error).toContain("unknown or expired");
    expect(executeOneShot).not.toHaveBeenCalled();
  });
});

describe("Task Force context barrier and resume", () => {
  it("rolls back every Task Force backend when cleanup closes admission during baseline capture", async () => {
    runtime = createCarrierRuntime();
    registerCarrier(runtime.registry, createConfig("ohio", "Ohio"));
    configureTaskForce("ohio");
    const baseline = defer<readonly [] | null>();
    const handles: OneShotExecution[] = [];
    vi.mocked(executeOneShot).mockImplementation((opts) => {
      const cliType = opts.cliType as CliType;
      const completion = defer<ExecResult>();
      const handle: OneShotExecution = {
        readiness: Promise.resolve({ cliType, protocol: protocolFor(cliType), sessionId: `session-${cliType}` }),
        completion: completion.promise,
        startPrompt: vi.fn(),
        abort: vi.fn(async () => { completion.resolve({ ...doneResult(`session-${cliType}`), status: "aborted" }); }),
      };
      handles.push(handle);
      return handle;
    });
    const scanner = { snapshot: vi.fn(() => baseline.promise) };
    const tool = runtime.buildDispatchToolSpec({ ...deps, workspaceChangeScanner: scanner });

    const pending = tool.execute({ carrier_id: "ohio", label: "Task Force cleanup race", request: "Do not open either prompt gate." }, { cwd: "/tmp", toolCallId: "taskforce-cleanup-race" });
    await vi.waitFor(() => expect(scanner.snapshot).toHaveBeenCalledTimes(1));
    await runtime.cleanup();
    baseline.resolve([]);

    const result = await pending;
    expect(details(result)).toMatchObject({ accepted: false, error: "Carrier runtime is closed to new dispatches." });
    expect(handles).toHaveLength(2);
    for (const handle of handles) {
      expect(handle.startPrompt).not.toHaveBeenCalled();
      expect(handle.abort).toHaveBeenCalledTimes(1);
    }
    expect(getJobSummary("taskforce:taskforce-cleanup-race", Date.now())).toBeNull();
  });

  it("aborts every backend and sends zero prompts when one readiness fails", async () => {
    runtime = createCarrierRuntime();
    registerCarrier(runtime.registry, createConfig("ohio", "Ohio"));
    configureTaskForce("ohio");
    vi.mocked(executeOneShot).mockImplementation((opts) => {
      const cliType = opts.cliType as CliType;
      if (cliType === "codex") {
        return {
          readiness: Promise.reject(new Error("codex readiness failed")),
          completion: Promise.resolve(doneResult("codex")),
          startPrompt: vi.fn(),
          abort: vi.fn(async () => {}),
        };
      }
      return resolvedHandle(cliType);
    });
    const tool = runtime.buildDispatchToolSpec(deps);

    const result = await tool.execute({ carrier_id: "ohio", label: "TF barrier", request: "Run both." }, { cwd: "/tmp", toolCallId: "tf-fail" });

    expect(details(result).accepted).toBe(false);
    // Both handles were built, but the barrier opened no prompt gate.
    expect(executeOneShot).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(executeOneShot).mock.results) {
      const handle = call.value as OneShotExecution;
      expect(handle.startPrompt).not.toHaveBeenCalled();
    }
    // A failed first turn commits nothing.
    expect(runtime.dispatchContexts.size).toBe(0);
  });

  it("resumes each backend by its own session without cross-wiring", async () => {
    runtime = createCarrierRuntime();
    registerCarrier(runtime.registry, createConfig("ohio", "Ohio"));
    configureTaskForce("ohio");
    vi.mocked(executeOneShot).mockImplementation((opts) => resolvedHandle(opts.cliType as CliType));
    const tool = runtime.buildDispatchToolSpec(deps);

    const first = await tool.execute({ carrier_id: "ohio", label: "TF first", request: "Run." }, { cwd: "/tmp", toolCallId: "tf1" });
    const contextId = details(first).context_id;
    expect(contextId).toMatch(/^ctx:/);
    await vi.waitFor(() => expect(runtime!.dispatchContexts.size).toBe(1));

    const resumed = await tool.execute({ carrier_id: "ohio", label: "TF resume", request: "Continue.", resume_context_id: contextId }, { cwd: "/tmp", toolCallId: "tf2" });
    await vi.waitFor(() => expect(executeOneShot).toHaveBeenCalledTimes(4));

    const resumeCalls = vi.mocked(executeOneShot).mock.calls.slice(2).map(([options]) => options);
    const claudeResume = resumeCalls.find((options) => options.cliType === "claude");
    const codexResume = resumeCalls.find((options) => options.cliType === "codex");
    expect(claudeResume?.resumeSessionId).toBe("session-claude");
    expect(codexResume?.resumeSessionId).toBe("session-codex");
    expect(details(resumed).context_id).toBe(contextId);
  });

  it("rolls back every prepared Task Force resource when readiness confirmation rejects a resumed binding", async () => {
    runtime = createCarrierRuntime();
    registerCarrier(runtime.registry, createConfig("ohio", "Ohio"));
    configureTaskForce("ohio");
    vi.mocked(executeOneShot).mockImplementation((opts) => resolvedHandle(opts.cliType as CliType));
    const tool = runtime.buildDispatchToolSpec(deps);

    const first = await tool.execute({ carrier_id: "ohio", label: "TF first", request: "Run." }, { cwd: "/tmp", toolCallId: "tf-confirm-first" });
    const contextId = details(first).context_id;
    expect(contextId).toMatch(/^ctx:/);
    await vi.waitFor(() => expect(runtime!.dispatchContexts.size).toBe(1));

    const rejectedHandles: OneShotExecution[] = [];
    vi.mocked(executeOneShot).mockReset();
    vi.mocked(executeOneShot).mockImplementation((opts) => {
      const cliType = opts.cliType as CliType;
      const handle: OneShotExecution = {
        readiness: Promise.resolve({
          cliType,
          protocol: cliType === "codex" ? "acp" : protocolFor(cliType),
          sessionId: `mismatched-${cliType}`,
        }),
        completion: Promise.resolve(doneResult(`mismatched-${cliType}`)),
        startPrompt: vi.fn(),
        abort: vi.fn(async () => {}),
      };
      rejectedHandles.push(handle);
      return handle;
    });

    const rejected = await tool.execute({
      carrier_id: "ohio",
      label: "TF mismatched resume",
      request: "Resume with a changed provider protocol.",
      resume_context_id: contextId,
    }, { cwd: "/tmp", toolCallId: "tf-confirm-rejected" });

    expect(details(rejected)).toMatchObject({ accepted: false, error: "context_id binding mismatch" });
    expect(rejectedHandles).toHaveLength(2);
    for (const handle of rejectedHandles) {
      expect(handle.startPrompt).not.toHaveBeenCalled();
      expect(handle.abort).toHaveBeenCalledTimes(1);
    }
    expect(getJobSummary("taskforce:tf-confirm-rejected", Date.now())).toBeNull();
    expect(runtime.dispatchContexts.size).toBe(1);

    vi.mocked(executeOneShot).mockReset();
    vi.mocked(executeOneShot).mockImplementation((opts) => resolvedHandle(opts.cliType as CliType));
    const retry = await tool.execute({
      carrier_id: "ohio",
      label: "TF retry",
      request: "Resume after the rejected readiness confirmation.",
      resume_context_id: contextId,
    }, { cwd: "/tmp", toolCallId: "tf-confirm-retry" });
    expect(details(retry)).toMatchObject({ accepted: true, context_id: contextId });
  });
});
