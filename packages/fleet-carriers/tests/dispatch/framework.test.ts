import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeWithPool } from "@dotobokuri/fleet-infra/agent";
import type { AgentToolCtx } from "@dotobokuri/fleet-mcp-server";
import {
  buildCarrierDispatchToolSpec,
  type CarrierConfig,
  createCarrierRegistry,
  emitStreamEvent,
  buildCarrierRoster,
  getCarrierSourceDisplayName,
  initStore,
  registerCarrier,
  registerStreamHandler,
  resetStoreForTests,
  resolveCarrierDisplayName,
  setCarrierSubagentMode,
  updateCarrierDisplayName,
} from "../../src/index.js";

interface CarrierDispatchToolResult {
  details: unknown;
  isError: boolean;
}

vi.mock("@dotobokuri/fleet-infra/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dotobokuri/fleet-infra/agent")>();
  return {
    ...actual,
    executeWithPool: vi.fn(),
  };
});

const C1_CSI = "\u009b2J";

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

  it("uses states.json effort instead of the persona subagent defaultEffort", async () => {
    writeStates({
      models: {
        ohio: {
          model: "sonnet",
          effort: "max",
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
    const tool = buildCarrierDispatchToolSpec(registry);
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
      carrierId: "ohio",
      cliType: "claude",
      model: "sonnet",
      effort: "max",
    }));
  });
});

describe("carrier_dispatch native subagent mode rejection", () => {
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

  it("rejects a carrier in native subagent mode with direct invocation guidance", async () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("ohio", "Ohio"));
    setCarrierSubagentMode("ohio", true);

    const tool = buildCarrierDispatchToolSpec(registry);
    const result = await tool.execute({
      carrier_id: "ohio",
      label: "Check subagent guard",
      request: "Verify dispatch rejection.",
    }, {
      cwd: "/tmp",
      toolCallId: "dispatch-subagent-mode",
    }) as CarrierDispatchToolResult;

    expect(result.details).toEqual({
      job_id: "carrier:dispatch-subagent-mode",
      accepted: false,
      error: `Carrier "ohio" is in native subagent mode and is unreachable via carrier_dispatch. Invoke it directly as the native subagent "Ohio".`,
    });
    expect(result.isError).toBe(true);
    expect(executeWithPool).not.toHaveBeenCalled();
  });

  it("rejects a subagent-mode carrier before Task Force auto-promotion", async () => {
    writeStates({
      carrierModes: {
        ohio: "subagent",
      },
      models: {
        ohio: {
          model: "sonnet",
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

    const tool = buildCarrierDispatchToolSpec(registry);
    const result = await tool.execute({
      carrier_id: "ohio",
      label: "Check Task Force guard order",
      request: "Verify dispatch rejection.",
    }, {
      cwd: "/tmp",
      toolCallId: "dispatch-subagent-taskforce",
    }) as CarrierDispatchToolResult;

    expect(result.details).toEqual({
      job_id: "carrier:dispatch-subagent-taskforce",
      accepted: false,
      error: `Carrier "ohio" is in native subagent mode and is unreachable via carrier_dispatch. Invoke it directly as the native subagent "Ohio".`,
    });
    expect(result.isError).toBe(true);
    expect(executeWithPool).not.toHaveBeenCalled();
  });
});

function createConfig(id: string, displayName: string): CarrierConfig {
  return {
    id,
    defaultCliType: "claude",
    slot: 1,
    displayName,
    color: "",
  };
}

function writeStates(value: unknown): void {
  if (!tempDir) throw new Error("테스트 store가 초기화되지 않았습니다.");
  fs.writeFileSync(path.join(tempDir, "states.json"), JSON.stringify(value), "utf-8");
}
