import { beforeEach, describe, expect, it, vi } from "vitest";

import { CarrierStatusOverlay } from "../../src/carrier-status/overlay.js";
import type {
  CarrierOverlayCallbacks,
  CarrierStatusEntry,
  CliModelInfo,
  OverlayState,
} from "@sbluemin/fleet-core";
import type { ProviderKey } from "@sbluemin/fleet-unified-agent";

vi.mock("@sbluemin/fleet-unified-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sbluemin/fleet-unified-agent")>();
  return {
    ...actual,
    getEffort: vi.fn((_cli: string, modelId: string) => {
      if (modelId.includes("gemini")) return { supported: false };
      return {
        supported: true,
        levels: ["low", "medium", "high"],
        default: "high",
      };
    }),
  };
});

interface DeferredPromise<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): DeferredPromise<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeEntry(): CarrierStatusEntry {
  return {
    carrierId: "alpha",
    slot: 1,
    cliType: "claude",
    defaultCliType: "claude",
    displayName: "Alpha",
    model: "claude-a",
    isDefault: false,
    effort: "high",
    role: null,
    roleDescription: null,
    isSortieEnabled: true,
    taskForceBackendCount: 0,
  };
}

function makeProvider(defaultModel: string, effortLevels?: string[], defaultEffort?: string): CliModelInfo {
  return {
    defaultModel,
    models: [
      { modelId: defaultModel, name: `${defaultModel} name` },
      { modelId: `${defaultModel}-alt`, name: `${defaultModel} alt` },
    ],
    effort: effortLevels
      ? {
        supported: true,
        levels: effortLevels,
        default: defaultEffort ?? effortLevels[0],
      }
      : {
        supported: false,
      },
  };
}

function createOverlay(options?: {
  entries?: CarrierStatusEntry[];
  providers?: Partial<Record<ProviderKey, CliModelInfo>>;
  saveModelSelection?: CarrierOverlayCallbacks["saveModelSelection"];
}) {
  const entries = options?.entries ?? [makeEntry()];
  const providers = {
    claude: makeProvider("claude-a", ["low", "high"], "low"),
    codex: makeProvider("codex-a", ["medium", "high"], "medium"),
    gemini: makeProvider("gemini-a"),
    "opencode-go": makeProvider("opencode-go/glm-5.1", ["low", "medium", "high"], "high"),
    "claude-zai": makeProvider("zai-coding-plan/glm-5.1", ["low", "medium", "high"], "high"),
    "claude-kimi": makeProvider("kimi-for-coding/k2p6", ["low", "medium", "high"], "high"),
    ...options?.providers,
  };
  const requestRender = vi.fn();
  const done = vi.fn();
  const callbacks: CarrierOverlayCallbacks = {
    getEntries: () => entries,
    changeCliType: vi.fn(async () => ({
      model: "codex-a",
      effort: "medium",
      isDefault: true,
    })),
    changeCliTypes: vi.fn(async () => []),
    resetCliTypesToDefault: vi.fn(async () => []),
    saveModelSelection: options?.saveModelSelection ?? vi.fn(async () => undefined),
    toggleSortieEnabled: vi.fn(),
    openTaskForce: vi.fn(),
    getAvailableModels: (cliType) => providers[cliType] ?? makeProvider(String(cliType)),
    getServiceSnapshots: () => new Map([
      ["claude", { status: "operational" }],
      ["codex", { status: "operational" }],
      ["gemini", { status: "operational" }],
      ["opencode-go", { status: "unknown" }],
      ["claude-zai", { status: "unknown" }],
      ["claude-kimi", { status: "unknown" }],
    ]),
    getDefaultCliType: () => "claude",
  };

  const overlay = new CarrierStatusOverlay(
    { requestRender } as any,
    { fg: (_token: string, value: string) => value } as any,
    entries,
    callbacks,
    done,
  );

  return { callbacks, done, entries, overlay, requestRender };
}

function getOverlayState(overlay: CarrierStatusOverlay): OverlayState {
  return (overlay as any).state as OverlayState;
}

describe("CarrierStatusOverlay state transitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("browse에서 Enter를 누르면 carrierId를 포함한 model 상태로 진입한다", () => {
    const { overlay } = createOverlay();

    overlay.handleInput("\r");

    expect(getOverlayState(overlay)).toEqual({
      kind: "model",
      carrierId: "alpha",
      choices: ["claude-a", "claude-a-alt"],
      cursor: 0,
    });
  });

  it("browse에서 c를 누르면 carrierId를 포함한 cliType 상태로 진입한다", () => {
    const { overlay } = createOverlay();

    overlay.handleInput("c");

    expect(getOverlayState(overlay)).toMatchObject({
      kind: "cliType",
      carrierId: "alpha",
    });
  });

  it("model 상태에서 Enter를 누르면 effort가 필요할 때 effort 상태로 진입한다", () => {
    const { overlay } = createOverlay();

    overlay.handleInput("\r");
    overlay.handleInput("\r");

    expect(getOverlayState(overlay)).toEqual({
      kind: "effort",
      carrierId: "alpha",
      pendingModel: "claude-a",
      choices: ["low", "medium", "high"],
      cursor: 2,
    });
  });

  it("model 상태에서 Enter를 누르면 effort가 없을 때 saving 상태로 바로 진입한다", () => {
    const deferred = createDeferred<void>();
    const { overlay } = createOverlay({
      entries: [{
        ...makeEntry(),
        cliType: "gemini",
        defaultCliType: "gemini",
        model: "gemini-a",
        effort: null,
      }],
      saveModelSelection: vi.fn(() => deferred.promise),
    });

    overlay.handleInput("\r");
    overlay.handleInput("\r");

    expect(getOverlayState(overlay)).toEqual({ kind: "saving" });
    deferred.resolve();
  });

  it("browse에서 C를 누르면 choices를 포함한 batchFrom 상태로 진입한다", () => {
    const { overlay } = createOverlay({
      entries: [
        makeEntry(),
        {
          ...makeEntry(),
          carrierId: "beta",
          displayName: "Beta",
          slot: 2,
          cliType: "codex",
          defaultCliType: "codex",
          model: "codex-a",
          effort: "medium",
        },
      ],
    });

    overlay.handleInput("C");

    const state = getOverlayState(overlay);
    expect(state.kind).toBe("batchFrom");
    if (state.kind === "batchFrom") {
      expect(state.choices.map((choice) => choice.cliType)).toEqual(["gemini", "claude", "claude-zai", "claude-kimi", "codex", "opencode-go", "cursor"]);
    }
  });

  it("batchFrom 상태에서 Enter를 누르면 fromCli를 포함한 batchTo 상태로 진입한다", () => {
    const { overlay } = createOverlay();

    overlay.handleInput("C");
    overlay.handleInput("\r");

    expect(getOverlayState(overlay)).toEqual({
      kind: "batchTo",
      fromCli: "claude",
      choices: [
        {
          cliType: "gemini",
          label: "Google Gemini CLI (0 carriers)",
          carrierCount: 0,
          status: "operational",
        },
        {
          cliType: "claude-zai",
          label: "Claude Code with Z.AI GLM (0 carriers)",
          carrierCount: 0,
          status: "unknown",
        },
        {
          cliType: "claude-kimi",
          label: "Claude Code with Moonshot Kimi (0 carriers)",
          carrierCount: 0,
          status: "unknown",
        },
        {
          cliType: "codex",
          label: "OpenAI Codex CLI (0 carriers)",
          carrierCount: 0,
          status: "operational",
        },
        {
          cliType: "opencode-go",
          label: "OpenCode Go (0 carriers)",
          carrierCount: 0,
          status: "unknown",
        },
        {
          cliType: "cursor",
          label: "Cursor Agent (0 carriers)",
          carrierCount: 0,
          status: "unknown",
        },
      ],
      cursor: 0,
    });
  });

  it("Esc는 편집 상태에서 browse로 복귀한다", () => {
    const { overlay } = createOverlay();

    overlay.handleInput("\r");
    expect(getOverlayState(overlay).kind).toBe("model");

    overlay.handleInput("\x1b");

    expect(getOverlayState(overlay)).toEqual({ kind: "browse" });
  });
});
