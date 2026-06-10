import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeWithPool } from "@dotobokuri/core-agent";
import type { AgentToolCtx } from "@dotobokuri/core-mcp-server";
import { getEffort, getProviderModels, type CliType } from "@dotobokuri/core-unified-agent";
import {
  buildCarrierDispatchToolSpec,
  PRIOR_JOBS_REQUEST_HINT,
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
  setCarrierAgentMode,
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
    executeWithPool: vi.fn(),
  };
});

const C1_CSI = "\u009b2J";
const testDeps = {
  authEnvResolver: () => Promise.resolve({}),
};

let tempDir: string | null = null;

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
});

describe("carrier_dispatch effort resolution", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-dispatch-effort-"));
    initStore(tempDir);
    vi.mocked(executeWithPool).mockResolvedValue({
      status: "done",
      responseText: "ok",
      thoughtText: "",
      toolCalls: [],
    });
  });

  afterEach(() => {
    vi.mocked(executeWithPool).mockReset();
    resetStoreForTests();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("uses carriers.json effort instead of the persona subagent defaultEffort", async () => {
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
    registerCarrier(registry, {
      ...createConfig("ohio", "Ohio"),
      subagent: {
        provider: "claude",
        defaultModel: "sonnet",
        defaultEffort: "low",
      },
    });
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
      expect(executeWithPool).toHaveBeenCalledTimes(1);
    });
    expect(executeWithPool).toHaveBeenCalledWith(expect.objectContaining({
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
      expect(executeWithPool).toHaveBeenCalledTimes(1);
    });
    expect(executeWithPool).toHaveBeenCalledWith(expect.objectContaining({
      scopeId: "ohio",
      cliType: "claude",
      model: "sonnet",
      effort: "max",
    }));
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
      expect(executeWithPool).toHaveBeenCalledTimes(1);
    });
    expect(executeWithPool).toHaveBeenCalledWith(expect.objectContaining({
      scopeId: "ohio",
      cliType: "claude",
      effort,
      model,
    }));
  });
});

describe("carrier_dispatch native subagent mode delegation", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-dispatch-subagent-mode-"));
    initStore(tempDir);
    vi.mocked(executeWithPool).mockResolvedValue({
      status: "done",
      responseText: "ok",
      thoughtText: "",
      toolCalls: [],
    });
  });

  afterEach(() => {
    vi.mocked(executeWithPool).mockReset();
    resetStoreForTests();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("accepts a carrier in native subagent mode as a single dispatch", async () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("ohio", "Ohio"));
    setCarrierAgentMode("ohio", true);

    const tool = buildCarrierDispatchToolSpec(registry, testDeps);
    const result = await tool.execute({
      carrier_id: "ohio",
      label: "Check subagent dispatch",
      request: "Verify dispatch acceptance.",
    }, {
      cwd: "/tmp",
      toolCallId: "dispatch-subagent-mode",
    }) as CarrierDispatchToolResult;

    expect(result.details).toEqual({
      job_id: "carrier:dispatch-subagent-mode",
      accepted: true,
    });
    expect(result.isError).toBe(false);
    await vi.waitFor(() => {
      expect(executeWithPool).toHaveBeenCalledTimes(1);
    });
    expect(executeWithPool).toHaveBeenCalledWith(expect.objectContaining({
      scopeId: "ohio",
    }));
  });

  it("rejects a subagent-mode carrier with missing required request blocks before launch", async () => {
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
    setCarrierAgentMode("ohio", true);

    const tool = buildCarrierDispatchToolSpec(registry, testDeps);
    const result = await tool.execute({
      carrier_id: "ohio",
      label: "Check request block guard",
      request: "Verify malformed dispatch rejection.",
    }, {
      cwd: "/tmp",
      toolCallId: "dispatch-subagent-missing-block",
    }) as CarrierDispatchToolResult;

    expect(result.details).toEqual({
      job_id: "carrier:dispatch-subagent-missing-block",
      accepted: false,
      error: `Missing required request block(s) for carrier "ohio": <objective> (missing closing tag). Include the required tag(s) in the request and resubmit.`,
    });
    expect(result.isError).toBe(true);
    expect(executeWithPool).not.toHaveBeenCalled();
  });

  it("accepts a carrier whose persona default agentMode is native subagent", async () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, { ...createConfig("ohio", "Ohio"), defaultAgentMode: "subagent" });

    const tool = buildCarrierDispatchToolSpec(registry, testDeps);
    const result = await tool.execute({
      carrier_id: "ohio",
      label: "Check default subagent dispatch",
      request: "Verify dispatch acceptance.",
    }, {
      cwd: "/tmp",
      toolCallId: "dispatch-default-subagent-mode",
    }) as CarrierDispatchToolResult;

    expect(result.details).toEqual({
      job_id: "carrier:dispatch-default-subagent-mode",
      accepted: true,
    });
    expect(result.isError).toBe(false);
    await vi.waitFor(() => {
      expect(executeWithPool).toHaveBeenCalledTimes(1);
    });
    expect(executeWithPool).toHaveBeenCalledWith(expect.objectContaining({
      scopeId: "ohio",
    }));
  });

  it("stores a window-approximate workspace manifest on single dispatch finalization", async () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("ohio", "Ohio"));
    const events: CarrierJobStreamEvent[] = [];
    const unregister = registerStreamHandler(registry, (event) => events.push(event));
    const scanner = createSequenceScanner([
      [],
      [{ status: "M", path: "src/file.ts" }],
    ]);
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
        attribution: "window-approximate",
        available: true,
        changes: [{ status: "M", path: "src/file.ts" }],
        statLine: "1 file (window-approx)",
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
      expect(getJobSummary("carrier:dispatch-no-scanner", Date.now())?.workspaceChanges).toMatchObject({
        available: false,
        reason: "scanner-not-configured",
        statLine: "unavailable",
      });
    });
  });

  it("skips Task Force auto-promotion for a subagent-mode carrier", async () => {
    writeStates({
      carriers: {
        ohio: {
          agentMode: "subagent",
          taskforce: {
            claude: {
              model: "sonnet",
              effort: "medium",
            },
            codex: {
              model: "gpt-5.4",
              effort: "high",
            },
          },
        },
      },
    });
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("ohio", "Ohio"));

    const tool = buildCarrierDispatchToolSpec(registry, testDeps);
    const result = await tool.execute({
      carrier_id: "ohio",
      label: "Check Task Force skip",
      request: "Verify single dispatch.",
    }, {
      cwd: "/tmp",
      toolCallId: "dispatch-subagent-taskforce",
    }) as CarrierDispatchToolResult;

    expect(result.details).toEqual({
      job_id: "carrier:dispatch-subagent-taskforce",
      accepted: true,
    });
    expect(result.isError).toBe(false);
    await vi.waitFor(() => {
      expect(executeWithPool).toHaveBeenCalledTimes(1);
    });
    expect(executeWithPool).toHaveBeenCalledWith(expect.objectContaining({
      scopeId: "ohio",
    }));
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
    setCarrierAgentMode("ohio", true);
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
    vi.mocked(executeWithPool).mockResolvedValue({
      status: "done",
      responseText: "ok",
      thoughtText: "",
      toolCalls: [],
    });
  });

  afterEach(() => {
    vi.mocked(executeWithPool).mockReset();
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
    setCarrierAgentMode("ohio", false, "subagent");
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
        displayName: "Claude Code with Anthropic",
        effort: claudeEffort,
        kind: "backend",
        model: claudeModel,
      }),
      expect.objectContaining({
        displayCli: "codex",
        displayName: "OpenAI Codex CLI",
        effort: codexEffort,
        kind: "backend",
        model: codexModel,
      }),
    ]);
  });

  it("stores a window-approximate workspace manifest on Task Force finalization", async () => {
    const claudeModel = firstModel("claude");
    const codexModel = firstModel("codex");
    updateTaskForceModelSelection("ohio", "claude", { model: claudeModel, effort: firstEffort("claude", claudeModel) });
    updateTaskForceModelSelection("ohio", "codex", { model: codexModel, effort: firstEffort("codex", codexModel) });
    setCarrierAgentMode("ohio", false, "subagent");
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("ohio", "Ohio"));
    const events: CarrierJobStreamEvent[] = [];
    const unregister = registerStreamHandler(registry, (event) => events.push(event));
    const scanner = createSequenceScanner([
      [],
      [{ status: "A", path: "docs/plan.md" }],
    ]);
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
        attribution: "window-approximate",
        available: true,
        changes: [{ status: "A", path: "docs/plan.md" }],
        statLine: "1 file (window-approx)",
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
          agentMode: "cli",
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
    expect(executeWithPool).not.toHaveBeenCalled();
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
