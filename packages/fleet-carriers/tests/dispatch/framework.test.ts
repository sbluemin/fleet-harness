import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeOneShot } from "@dotobokuri/core-agent";
import type { AgentToolCtx, ExecResult, OneShotExecution, OneShotReady } from "@dotobokuri/core-agent";
import { getEffort, getProviderModels, type CliType, type ProtocolType } from "@dotobokuri/core-unified-agent";
import {
  buildCarrierDispatchToolSpec,
  buildCarrierStatusEntries,
  PRIOR_JOBS_REQUEST_HINT,
  readCarrierStatusEntries,
  type CarrierConfig,
  type CarrierJobStreamEvent,
  createCarrierRegistry,
  emitStreamEvent,
  buildCarrierRoster,
  getCarrierSourceDisplayName,
  getJobSummary,
  initStore,
  registerCarrier,
  registerStreamHandler,
  resetStoreForTests,
  resolveCarrierDisplayName,
  updateTaskForceModelSelection,
  updateCarrierDisplayName,
} from "../../src/index.js";
import type { WorkspaceChangeScanner, WorkspaceChangeSnapshotEntry } from "../../src/jobs/workspace-manifest.js";

interface CarrierDispatchToolResult {
  details: unknown;
  isError: boolean;
}

vi.mock("@dotobokuri/core-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dotobokuri/core-agent")>();
  return {
    ...actual,
    executeOneShot: vi.fn(),
  };
});

const C1_CSI = "\u009b2J";
const testDeps = {
  authEnvResolver: () => Promise.resolve({}),
};

let tempDir: string | null = null;

// ── One-shot handle stubbing ────────────────────────────────
// executeOneShot returns a two-phase handle synchronously; readiness resolves
// (or rejects) before the prompt gate opens, and completion carries the turn result.

function protocolFor(cliType: CliType): ProtocolType {
  return cliType === "codex" ? "codex-app-server" : "acp";
}

function stubOneShot(
  cliType: CliType,
  overrides?: { result?: Partial<ExecResult>; ready?: Partial<OneShotReady>; readinessError?: unknown },
): OneShotExecution {
  const ready: OneShotReady = {
    cliType,
    protocol: protocolFor(cliType),
    sessionId: `session-${cliType}`,
    ...overrides?.ready,
  };
  const result: ExecResult = {
    status: "done",
    responseText: "ok",
    thoughtText: "",
    toolCalls: [],
    sessionId: ready.sessionId,
    ...overrides?.result,
  };
  return {
    readiness: overrides?.readinessError !== undefined
      ? Promise.reject(overrides.readinessError)
      : Promise.resolve(ready),
    completion: Promise.resolve(result),
    startPrompt: vi.fn(),
    abort: vi.fn(async () => {}),
  };
}

/** Default: every backend reaches readiness and completes `done`. */
function mockOneShotResolved(): void {
  vi.mocked(executeOneShot).mockImplementation((opts) => stubOneShot(opts.cliType as CliType));
}

describe("carrier displayName resolution", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-framework-display-names-"));
    initStore(tempDir);
  });

  afterEach(() => {
    resetStoreForTests();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("applies persisted displayName sanitizer policy to source display names", () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("custom_alpha", "  Alpha\u200B\u202E Prime  "));

    expect(getCarrierSourceDisplayName(registry, "custom_alpha")).toBe("Alpha Prime");
    expect(resolveCarrierDisplayName(registry, "custom_alpha")).toBe("Alpha Prime");
  });

  it("blocks source display names containing C0, DEL, or C1 controls", () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("custom_alpha", `Alpha${C1_CSI}Prime`));

    expect(getCarrierSourceDisplayName(registry, "custom_alpha")).toBe("custom_alpha");
    expect(resolveCarrierDisplayName(registry, "custom_alpha")).toBe("custom_alpha");
  });

  it("preserves persisted override and delete semantics over sanitized source defaults", () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("custom_alpha", "Alpha\u200B Prime"));

    updateCarrierDisplayName("custom_alpha", "Alpha Override", getCarrierSourceDisplayName(registry, "custom_alpha"));
    expect(resolveCarrierDisplayName(registry, "custom_alpha")).toBe("Alpha Override");

    updateCarrierDisplayName("custom_alpha", "Alpha Prime", getCarrierSourceDisplayName(registry, "custom_alpha"));
    expect(resolveCarrierDisplayName(registry, "custom_alpha")).toBe("Alpha Prime");
  });

  it("builds display-safe carrier status entries from the carrier-owned read model", () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, {
      ...createConfig("custom_alpha", "Alpha"),
      carrierMetadata: {
        category: "operations",
        outputFormat: "",
        permissions: [],
        requestBlocks: [],
        summary: "Coordinates local execution",
        title: "Operator",
        whenNotToUse: [],
        whenToUse: [],
      },
      defaultModel: firstModel("claude"),
    });

    const entries = buildCarrierStatusEntries(registry);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      carrierId: "custom_alpha",
      category: "operations",
      cliType: "claude",
      defaultCliType: "claude",
      displayName: "Alpha",
      role: "Operator",
      roleDescription: "Operator - Coordinates local execution",
      slot: 1,
      taskForceBackendCount: 0,
    });
    expect(JSON.stringify(entries[0])).not.toContain("permissions");
    expect(JSON.stringify(entries[0])).not.toContain("outputFormat");
    expect(JSON.stringify(entries[0])).not.toContain("allowedExecutorTools");
  });

  it("reads persisted carrier status entries from the carrier store file", () => {
    writeStates({
      carriers: {
        custom_alpha: {
          agentCli: {
            claude: {
              model: firstModel("claude"),
              effort: firstEffort("claude", firstModel("claude")),
            },
          },
          displayName: "Alpha Persisted",
        },
      },
    });
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("custom_alpha", "Alpha"));

    const entries = readCarrierStatusEntries(registry);

    expect(entries[0]).toMatchObject({
      carrierId: "custom_alpha",
      displayName: "Alpha Persisted",
      model: firstModel("claude"),
      effort: firstEffort("claude", firstModel("claude")),
    });
  });
});

describe("carrier stream handler registry", () => {
  it("clears stream handlers with the carrier registry", () => {
    const registry = createCarrierRegistry();
    const events: string[] = [];
    registerStreamHandler(registry, (event) => events.push(event.type));

    registry.clear();
    emitStreamEvent(registry, {
      type: "track:text",
      jobId: "carrier:call-1",
      trackId: "genesis",
      text: "ignored",
    });

    expect(events).toEqual([]);
  });
});

describe("carrier roster rendering", () => {
  it("excludes requested carrier IDs from the normal carrier_dispatch roster", () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("ohio", "Ohio"));
    registerCarrier(registry, createConfig("sentinel", "Sentinel"));

    const roster = buildCarrierRoster(registry, ["ohio", "sentinel"], {
      excludeCarrierIds: ["ohio"],
    });

    expect(roster).not.toContain("**ohio**");
    expect(roster).not.toContain('carrier_id: "ohio"');
    expect(roster).toContain("**sentinel**");
    expect(roster).toContain('carrier_id: "sentinel"');
  });

  it("renders the shared prior_jobs preamble once before carrier entries", () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("ohio", "Ohio"));
    const preamble = `All carriers accept an optional <prior_jobs> block: ${PRIOR_JOBS_REQUEST_HINT}`;

    const roster = buildCarrierRoster(registry, ["ohio"], {
      preambleLines: [preamble],
    });

    expect(roster.match(/<prior_jobs>/g)).toHaveLength(1);
    expect(roster.indexOf(preamble)).toBeLessThan(roster.indexOf("**ohio**"));
  });

  it("renders the routing tier without request-block contracts", () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfigWithBlocks("ohio", "Ohio"));

    const roster = buildCarrierRoster(registry, ["ohio"], { tier: "routing" });

    expect(roster).toContain("Use for:");
    expect(roster).toContain("NOT for:");
    expect(roster).not.toContain("Request blocks");
    expect(roster).not.toContain("<plan_file>");
  });

  it("renders the contracts tier with request blocks only", () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfigWithBlocks("ohio", "Ohio"));

    const roster = buildCarrierRoster(registry, ["ohio"], { tier: "contracts" });

    expect(roster).toContain("<plan_file> required:");
    expect(roster).toContain("<objective?> optional:");
    expect(roster).not.toContain("Use for:");
    expect(roster).not.toContain("NOT for:");
    expect(roster).not.toContain('carrier_id: "ohio"');
  });

  it("renders blockless carriers as free-form in the contracts tier", () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("ohio", "Ohio"));

    const roster = buildCarrierRoster(registry, ["ohio"], { tier: "contracts" });

    expect(roster).toContain("free-form request body — no structured request blocks");
  });

  it("omits full render entries for default (tierless) calls unchanged", () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfigWithBlocks("ohio", "Ohio"));

    const roster = buildCarrierRoster(registry, ["ohio"]);

    expect(roster).toContain("Use for:");
    expect(roster).toContain("Request blocks — wrap content in these (? = optional):");
    expect(roster).toContain("<plan_file> required:");
  });
});

describe("carrier_dispatch effort resolution", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-dispatch-effort-"));
    initStore(tempDir);
    mockOneShotResolved();
  });

  afterEach(() => {
    vi.mocked(executeOneShot).mockReset();
    resetStoreForTests();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("uses carriers.json effort instead of the persona dispatch defaultEffort", async () => {
    writeStates({
      carriers: {
        ohio: {
          agentCli: {
            claude: {
              model: "sonnet",
              effort: "max",
            },
          },
        },
      },
    });
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("ohio", "Ohio"));
    const tool = buildCarrierDispatchToolSpec(registry, testDeps);
    const ctx: AgentToolCtx = {
      cwd: "/tmp",
      toolCallId: "dispatch-effort",
    };

    await tool.execute({
      carrier_id: "ohio",
      label: "Check dispatch effort",
      request: "Verify effort source.",
    }, ctx);

    await vi.waitFor(() => {
      expect(executeOneShot).toHaveBeenCalledTimes(1);
    });
    expect(executeOneShot).toHaveBeenCalledWith(expect.objectContaining({
      scopeId: "ohio",
      cliType: "claude",
      model: "sonnet",
      effort: "max",
    }));
  });

  it("uses persona dispatch defaults when no model state exists", async () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, {
      ...createConfig("ohio", "Ohio"),
      defaultEffort: "max",
      defaultModel: "sonnet",
    });
    const tool = buildCarrierDispatchToolSpec(registry, testDeps);

    await tool.execute({
      carrier_id: "ohio",
      label: "Check dispatch defaults",
      request: "Verify dispatch defaults.",
    }, {
      cwd: "/tmp",
      toolCallId: "dispatch-defaults",
    });

    await vi.waitFor(() => {
      expect(executeOneShot).toHaveBeenCalledTimes(1);
    });
    expect(executeOneShot).toHaveBeenCalledWith(expect.objectContaining({
      scopeId: "ohio",
      cliType: "claude",
      model: "sonnet",
      effort: "max",
    }));
  });

  it("omits a resume session id for an untracked single dispatch", async () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, {
      ...createConfig("ohio", "Ohio"),
      defaultModel: "sonnet",
    });
    const tool = buildCarrierDispatchToolSpec(registry, testDeps);

    await tool.execute({
      carrier_id: "ohio",
      label: "Untracked dispatch",
      request: "Run without a resume_context_id.",
    }, {
      cwd: "/tmp",
      toolCallId: "dispatch-untracked",
    });

    await vi.waitFor(() => {
      expect(executeOneShot).toHaveBeenCalledTimes(1);
    });
    const [options] = vi.mocked(executeOneShot).mock.calls[0]!;
    expect(options.resumeSessionId).toBeUndefined();
  });

  it("emits single carrier model and effort in the registered track metadata", async () => {
    const model = firstModel("claude");
    const effort = firstEffort("claude", model);
    const registry = createCarrierRegistry();
    registerCarrier(registry, {
      ...createConfig("ohio", "Ohio"),
      defaultEffort: effort,
      defaultModel: model,
    });
    const events: CarrierJobStreamEvent[] = [];
    const unregister = registerStreamHandler(registry, (event) => events.push(event));
    const tool = buildCarrierDispatchToolSpec(registry, testDeps);

    await tool.execute({
      carrier_id: "ohio",
      label: "Check single dispatch metadata",
      request: "Verify single dispatch track metadata.",
    }, {
      cwd: "/tmp",
      toolCallId: "dispatch-single-metadata",
    });
    unregister();

    const registered = events.find((event) => event.type === "job:registered");
    expect(registered).toEqual(expect.objectContaining({
      jobId: "carrier:dispatch-single-metadata",
      kind: "carrier",
      ownerCarrierId: "ohio",
    }));
    if (registered?.type !== "job:registered") throw new Error("Single carrier job registration event was not emitted.");
    expect(registered.tracks).toEqual([
      expect.objectContaining({
        displayCli: "ohio",
        displayName: "Ohio",
        effort,
        kind: "carrier",
        model,
      }),
    ]);
    await vi.waitFor(() => {
      expect(executeOneShot).toHaveBeenCalledTimes(1);
    });
    expect(executeOneShot).toHaveBeenCalledWith(expect.objectContaining({
      scopeId: "ohio",
      cliType: "claude",
      effort,
      model,
    }));
  });
});

describe("carrier_dispatch readiness gating", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-dispatch-readiness-"));
    initStore(tempDir);
  });

  afterEach(() => {
    vi.mocked(executeOneShot).mockReset();
    resetStoreForTests();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("returns a sanitized synchronous rejection when readiness fails and emits no job", async () => {
    vi.mocked(executeOneShot).mockImplementation((opts) =>
      stubOneShot(opts.cliType as CliType, {
        readinessError: new Error("provider connect failed OPENAI_API_KEY=sk-should-be-redacted-000000000000"),
      }),
    );
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("ohio", "Ohio"));
    const events: CarrierJobStreamEvent[] = [];
    const unregister = registerStreamHandler(registry, (event) => events.push(event));
    const tool = buildCarrierDispatchToolSpec(registry, testDeps);

    const result = await tool.execute({
      carrier_id: "ohio",
      label: "Trigger readiness failure",
      request: "Fail before the prompt.",
    }, {
      cwd: "/tmp",
      toolCallId: "dispatch-readiness-fail",
    }) as CarrierDispatchToolResult;
    unregister();

    expect(result.isError).toBe(true);
    expect(result.details).toEqual(expect.objectContaining({
      job_id: "carrier:dispatch-readiness-fail",
      accepted: false,
    }));
    expect(JSON.stringify(result.details)).toContain("[REDACTED:generic_secret]");
    expect(JSON.stringify(result.details)).not.toContain("sk-should-be-redacted-000000000000");
    expect(events.some((event) => event.type === "job:registered")).toBe(false);
    // Rolled-back launch leaves no summary/archive residue.
    expect(getJobSummary("carrier:dispatch-readiness-fail", Date.now())).toBeNull();
  });

  it("awaits readiness before opening the prompt gate on a successful single dispatch", async () => {
    let startedBeforeReady = false;
    let releaseReady!: () => void;
    const readyGate = new Promise<void>((resolve) => { releaseReady = resolve; });
    vi.mocked(executeOneShot).mockImplementation((opts) => {
      const startPrompt = vi.fn();
      const ready: OneShotReady = { cliType: opts.cliType as CliType, protocol: protocolFor(opts.cliType as CliType), sessionId: "sess" };
      return {
        readiness: readyGate.then(() => {
          startedBeforeReady = startPrompt.mock.calls.length > 0;
          return ready;
        }),
        completion: Promise.resolve({ status: "done", responseText: "ok", thoughtText: "", toolCalls: [], sessionId: "sess" }),
        startPrompt,
        abort: vi.fn(async () => {}),
      };
    });
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("ohio", "Ohio"));
    const tool = buildCarrierDispatchToolSpec(registry, testDeps);

    const execution = tool.execute({
      carrier_id: "ohio",
      label: "Gate ordering",
      request: "Prompt must wait for readiness.",
    }, {
      cwd: "/tmp",
      toolCallId: "dispatch-gate-order",
    }) as Promise<CarrierDispatchToolResult>;
    releaseReady();
    const result = await execution;

    expect(result.details).toEqual({ job_id: "carrier:dispatch-gate-order", accepted: true });
    expect(startedBeforeReady).toBe(false);
    const [, execHandle] = [null, vi.mocked(executeOneShot).mock.results[0]!.value as OneShotExecution];
    expect(execHandle.startPrompt).toHaveBeenCalledTimes(1);
  });
});

describe("carrier_dispatch workspace manifest recording", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-dispatch-manifest-"));
    initStore(tempDir);
    mockOneShotResolved();
  });

  afterEach(() => {
    vi.mocked(executeOneShot).mockReset();
    resetStoreForTests();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("captures a single dispatch edit made immediately after the prompt gate opens", async () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("ohio", "Ohio"));
    const events: CarrierJobStreamEvent[] = [];
    const unregister = registerStreamHandler(registry, (event) => events.push(event));
    let edited = false;
    vi.mocked(executeOneShot).mockImplementation((opts) => {
      const handle = stubOneShot(opts.cliType as CliType);
      handle.startPrompt = vi.fn(() => { edited = true; });
      return handle;
    });
    const scanner: WorkspaceChangeScanner = {
      snapshot: vi.fn(async () => edited ? [{ status: "M", path: "src/file.ts" }] : []),
    };
    const tool = buildCarrierDispatchToolSpec(registry, { ...testDeps, workspaceChangeScanner: scanner });

    await tool.execute({
      carrier_id: "ohio",
      label: "Check manifest",
      request: "Verify manifest capture.",
    }, {
      cwd: "/tmp",
      toolCallId: "dispatch-manifest",
    });

    await vi.waitFor(() => {
      expect(getJobSummary("carrier:dispatch-manifest", Date.now())?.workspaceChanges).toMatchObject({
        changes: [{ status: "M", path: "src/file.ts" }],
        truncated: false,
      });
    });
    unregister();

    const finalized = events.find((event) => event.type === "job:finalized");
    expect(finalized?.type).toBe("job:finalized");
    if (finalized?.type !== "job:finalized") throw new Error("Single dispatch finalization event was not emitted.");
    expect(finalized.systemReminder).toContain("changes=1 file (window-approx)");
  });

  it("records scanner-not-configured without failing single dispatch", async () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("ohio", "Ohio"));
    const tool = buildCarrierDispatchToolSpec(registry, testDeps);

    const result = await tool.execute({
      carrier_id: "ohio",
      label: "Check missing scanner",
      request: "Verify missing scanner.",
    }, {
      cwd: "/tmp",
      toolCallId: "dispatch-no-scanner",
    }) as CarrierDispatchToolResult;

    expect(result.details).toEqual({
      job_id: "carrier:dispatch-no-scanner",
      accepted: true,
    });
    await vi.waitFor(() => {
      expect(getJobSummary("carrier:dispatch-no-scanner", Date.now())?.workspaceChanges).toBeUndefined();
    });
  });

  it("does not scan when request-block validation rejects before launch", async () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, {
      ...createConfig("ohio", "Ohio"),
      carrierMetadata: {
        category: "operations",
        outputFormat: "Report results.",
        permissions: [],
        requestBlocks: [
          { tag: "objective", hint: "Goal", required: true },
        ],
        summary: "Runs focused implementation work.",
        title: "Captain · Chief Engineer",
        whenNotToUse: [],
        whenToUse: ["implementation"],
      },
    });
    const scanner = createSequenceScanner([[]]);
    const tool = buildCarrierDispatchToolSpec(registry, { ...testDeps, workspaceChangeScanner: scanner });

    const result = await tool.execute({
      carrier_id: "ohio",
      label: "Check validation scanner skip",
      request: "Missing objective.",
    }, {
      cwd: "/tmp",
      toolCallId: "dispatch-validation-no-scan",
    }) as CarrierDispatchToolResult;

    expect(result.isError).toBe(true);
    expect(scanner.calls).toBe(0);
  });
});

describe("carrier_dispatch taskforce stream metadata", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-dispatch-taskforce-metadata-"));
    initStore(tempDir);
    mockOneShotResolved();
  });

  afterEach(() => {
    vi.mocked(executeOneShot).mockReset();
    resetStoreForTests();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("emits Task Force backend model and effort in the registered track metadata", async () => {
    const claudeModel = firstModel("claude");
    const codexModel = firstModel("codex");
    const claudeEffort = firstEffort("claude", claudeModel);
    const codexEffort = firstEffort("codex", codexModel);
    updateTaskForceModelSelection("ohio", "claude", { model: claudeModel, effort: claudeEffort });
    updateTaskForceModelSelection("ohio", "codex", { model: codexModel, effort: codexEffort });
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("ohio", "Ohio"));
    const events: CarrierJobStreamEvent[] = [];
    const unregister = registerStreamHandler(registry, (event) => events.push(event));
    const tool = buildCarrierDispatchToolSpec(registry, testDeps);

    await tool.execute({
      carrier_id: "ohio",
      label: "Check Task Force metadata",
      request: "Verify Task Force track metadata.",
    }, {
      cwd: "/tmp",
      toolCallId: "dispatch-taskforce-metadata",
    });
    unregister();

    const registered = events.find((event) => event.type === "job:registered");
    expect(registered).toEqual(expect.objectContaining({
      jobId: "taskforce:dispatch-taskforce-metadata",
      kind: "taskforce",
      ownerCarrierId: "ohio",
    }));
    if (registered?.type !== "job:registered") throw new Error("Task Force job registration event was not emitted.");
    expect(registered.tracks).toEqual([
      expect.objectContaining({
        displayCli: "claude",
        displayName: "Claude Code",
        effort: claudeEffort,
        kind: "backend",
        model: claudeModel,
      }),
      expect.objectContaining({
        displayCli: "codex",
        displayName: "Codex",
        effort: codexEffort,
        kind: "backend",
        model: codexModel,
      }),
    ]);
  });

  it("builds one fresh one-shot handle per Task Force backend with its own scope", async () => {
    const claudeModel = firstModel("claude");
    const codexModel = firstModel("codex");
    updateTaskForceModelSelection("ohio", "claude", { model: claudeModel, effort: firstEffort("claude", claudeModel) });
    updateTaskForceModelSelection("ohio", "codex", { model: codexModel, effort: firstEffort("codex", codexModel) });
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("ohio", "Ohio"));
    const tool = buildCarrierDispatchToolSpec(registry, testDeps);

    await tool.execute({ carrier_id: "ohio", label: "Task Force", request: "Run both backends." }, {
      cwd: "/tmp",
      sessionLabel: "terminal-a",
      toolCallId: "taskforce-fresh-handles",
    });

    await vi.waitFor(() => {
      expect(executeOneShot).toHaveBeenCalledTimes(2);
    });
    const calls = vi.mocked(executeOneShot).mock.calls.map(([options]) => options);
    expect(calls.map((options) => options.cliType).sort()).toEqual(["claude", "codex"]);
    for (const options of calls) {
      expect(options.scopeId).toBe("ohio");
      expect(options.resumeSessionId).toBeUndefined();
    }
  });

  it("captures Task Force edits made immediately after the shared prompt gate opens", async () => {
    const claudeModel = firstModel("claude");
    const codexModel = firstModel("codex");
    updateTaskForceModelSelection("ohio", "claude", { model: claudeModel, effort: firstEffort("claude", claudeModel) });
    updateTaskForceModelSelection("ohio", "codex", { model: codexModel, effort: firstEffort("codex", codexModel) });
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("ohio", "Ohio"));
    const events: CarrierJobStreamEvent[] = [];
    const unregister = registerStreamHandler(registry, (event) => events.push(event));
    let edited = false;
    vi.mocked(executeOneShot).mockImplementation((opts) => {
      const handle = stubOneShot(opts.cliType as CliType);
      handle.startPrompt = vi.fn(() => { edited = true; });
      return handle;
    });
    const scanner: WorkspaceChangeScanner = {
      snapshot: vi.fn(async () => edited ? [{ status: "A", path: "docs/plan.md" }] : []),
    };
    const tool = buildCarrierDispatchToolSpec(registry, { ...testDeps, workspaceChangeScanner: scanner });

    await tool.execute({
      carrier_id: "ohio",
      label: "Check Task Force manifest",
      request: "Verify Task Force manifest.",
    }, {
      cwd: "/tmp",
      toolCallId: "dispatch-taskforce-manifest",
    });

    await vi.waitFor(() => {
      expect(getJobSummary("taskforce:dispatch-taskforce-manifest", Date.now())?.workspaceChanges).toMatchObject({
        changes: [{ status: "A", path: "docs/plan.md" }],
        truncated: false,
      });
    });
    unregister();

    const finalized = events.find((event) => event.type === "job:finalized");
    expect(finalized?.type).toBe("job:finalized");
    if (finalized?.type !== "job:finalized") throw new Error("Task Force finalization event was not emitted.");
    expect(finalized.systemReminder).toContain("changes=1 file (window-approx)");
  });

  it("rejects invalid raw Task Force model config before starting a detached job", async () => {
    const codexModel = firstModel("codex");
    writeStates({
      carriers: {
        ohio: {
          agentMode: "subagent",
          taskforce: {
            claude: {
              model: "not-a-real-model",
              effort: "medium",
            },
            codex: {
              model: codexModel,
              effort: firstEffort("codex", codexModel),
            },
          },
        },
      },
    });
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("ohio", "Ohio"));
    const events: CarrierJobStreamEvent[] = [];
    const unregister = registerStreamHandler(registry, (event) => events.push(event));
    const tool = buildCarrierDispatchToolSpec(registry, testDeps);

    const result = await tool.execute({
      carrier_id: "ohio",
      label: "Check invalid Task Force metadata",
      request: "Verify invalid Task Force config rejection.",
    }, {
      cwd: "/tmp",
      toolCallId: "dispatch-taskforce-invalid-metadata",
    }) as CarrierDispatchToolResult;
    unregister();

    expect(result.isError).toBe(true);
    expect(result.details).toEqual(expect.objectContaining({
      job_id: "taskforce:dispatch-taskforce-invalid-metadata",
      accepted: false,
    }));
    expect(JSON.stringify(result.details)).toContain("not-a-real-model");
    expect(events.some((event) => event.type === "job:registered")).toBe(false);
    expect(executeOneShot).not.toHaveBeenCalled();
  });
});

describe("carrier_dispatch explicit cwd injection", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-dispatch-cwd-"));
    initStore(tempDir);
    mockOneShotResolved();
  });

  afterEach(() => {
    vi.mocked(executeOneShot).mockReset();
    resetStoreForTests();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("falls back to the host session cwd when no cwd argument is provided", async () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("ohio", "Ohio"));
    const tool = buildCarrierDispatchToolSpec(registry, testDeps);

    await tool.execute({
      carrier_id: "ohio",
      label: "No explicit cwd",
      request: "Run with host cwd.",
    }, {
      cwd: "/host/session/cwd",
      toolCallId: "dispatch-cwd-fallback",
    });

    await vi.waitFor(() => {
      expect(executeOneShot).toHaveBeenCalledTimes(1);
    });
    expect(executeOneShot).toHaveBeenCalledWith(expect.objectContaining({
      scopeId: "ohio",
      cwd: "/host/session/cwd",
    }));
  });

  it("forwards an explicit absolute cwd to the carrier spawn", async () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("ohio", "Ohio"));
    const tool = buildCarrierDispatchToolSpec(registry, testDeps);

    await tool.execute({
      carrier_id: "ohio",
      label: "Explicit worktree cwd",
      request: "Run in the worktree.",
      cwd: "/abs/worktree/path",
    }, {
      cwd: "/host/session/cwd",
      toolCallId: "dispatch-cwd-explicit",
    });

    await vi.waitFor(() => {
      expect(executeOneShot).toHaveBeenCalledTimes(1);
    });
    expect(executeOneShot).toHaveBeenCalledWith(expect.objectContaining({
      scopeId: "ohio",
      cwd: "/abs/worktree/path",
    }));
  });

  it("rejects a relative cwd before launching a job", async () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("ohio", "Ohio"));
    const tool = buildCarrierDispatchToolSpec(registry, testDeps);

    const result = await tool.execute({
      carrier_id: "ohio",
      label: "Relative cwd",
      request: "Should be rejected.",
      cwd: "relative/worktree",
    }, {
      cwd: "/host/session/cwd",
      toolCallId: "dispatch-cwd-relative",
    }) as CarrierDispatchToolResult;

    expect(result.isError).toBe(true);
    expect(result.details).toEqual(expect.objectContaining({
      job_id: "carrier:dispatch-cwd-relative",
      accepted: false,
    }));
    expect(JSON.stringify(result.details)).toContain("must be an absolute path");
    expect(executeOneShot).not.toHaveBeenCalled();
  });

  it("forwards an explicit absolute cwd to every Task Force backend spawn", async () => {
    const claudeModel = firstModel("claude");
    const codexModel = firstModel("codex");
    updateTaskForceModelSelection("ohio", "claude", { model: claudeModel, effort: firstEffort("claude", claudeModel) });
    updateTaskForceModelSelection("ohio", "codex", { model: codexModel, effort: firstEffort("codex", codexModel) });
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("ohio", "Ohio"));
    const tool = buildCarrierDispatchToolSpec(registry, testDeps);

    await tool.execute({
      carrier_id: "ohio",
      label: "Task Force worktree cwd",
      request: "Run Task Force in the worktree.",
      cwd: "/abs/worktree/path",
    }, {
      cwd: "/host/session/cwd",
      toolCallId: "dispatch-cwd-taskforce",
    });

    await vi.waitFor(() => {
      expect(executeOneShot).toHaveBeenCalledTimes(2);
    });
    for (const [options] of vi.mocked(executeOneShot).mock.calls) {
      expect(options.cwd).toBe("/abs/worktree/path");
    }
  });
});

function createConfig(id: string, displayName: string): CarrierConfig {
  return {
    id,
    defaultCliType: "claude",
    slot: 1,
    displayName,
  };
}

function createConfigWithBlocks(id: string, displayName: string): CarrierConfig {
  return {
    ...createConfig(id, displayName),
    carrierMetadata: {
      category: "operations",
      outputFormat: "",
      permissions: [],
      requestBlocks: [
        { tag: "plan_file", required: true, hint: "Repo-relative plan path." },
        { tag: "objective", required: false, hint: "Optional goal restatement." },
      ],
      summary: "Executes plan-driven waves",
      title: "Operator",
      whenNotToUse: ["single-file edits (→genesis)"],
      whenToUse: ["multi-wave builds"],
    },
  };
}

function createSequenceScanner(
  snapshots: (readonly WorkspaceChangeSnapshotEntry[] | null)[],
): WorkspaceChangeScanner & { calls: number } {
  return {
    calls: 0,
    async snapshot() {
      const index = this.calls++;
      return snapshots[index] ?? null;
    },
  };
}

function writeStates(value: unknown): void {
  if (!tempDir) throw new Error("테스트 store가 초기화되지 않았습니다.");
  fs.writeFileSync(path.join(tempDir, "carriers.json"), JSON.stringify(value), "utf-8");
}

function firstModel(cliType: CliType): string {
  const model = getProviderModels(cliType).models[0]?.modelId;
  if (!model) throw new Error(`No test model for ${cliType}`);
  return model;
}

function firstEffort(cliType: CliType, model: string): string {
  const effort = getEffort(cliType, model);
  const first = effort.supported ? effort.levels[0] : undefined;
  if (!first) throw new Error(`No test effort for ${cliType}/${model}`);
  return first;
}
