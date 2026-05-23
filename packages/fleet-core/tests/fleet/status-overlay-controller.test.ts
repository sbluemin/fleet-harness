import { describe, expect, it, vi, beforeEach } from "vitest";

import { StatusOverlayController } from "@sbluemin/fleet-carriers";
import type {
  CarrierCliType,
  CarrierStatusEntry,
  CliModelInfo,
  ModelSelection,
  CarrierConfig,
} from "@sbluemin/fleet-carriers";

interface TestState {
  configs: Map<string, CarrierConfig>;
  currentSelections: Record<string, (ModelSelection & { direct?: boolean }) | undefined>;
  entries: CarrierStatusEntry[];
  perCliSettings: Map<string, { model?: string; effort?: string; direct?: boolean }>;
  providers: Record<CarrierCliType, CliModelInfo>;
}

function makeCarrierConfig(
  id: string,
  cliType: CarrierCliType,
  defaultCliType: CarrierCliType = cliType,
): CarrierConfig {
  return {
    id,
    cliType,
    defaultCliType,
    slot: 1,
    displayName: id,
    color: "",
  } as CarrierConfig;
}

function makeEntry(
  carrierId: string,
  cliType: CarrierCliType,
  defaultCliType: CarrierCliType = cliType,
): CarrierStatusEntry {
  return {
    carrierId,
    slot: 1,
    cliType,
    defaultCliType,
    displayName: carrierId,
    model: `${cliType}-model`,
    isDefault: true,
    effort: null,
    role: null,
    roleDescription: null,
    taskForceBackendCount: 0,
  };
}

function makeProviders(): Record<CarrierCliType, CliModelInfo> {
  return {
    claude: {
      defaultModel: "claude-default",
      models: [
        { modelId: "claude-default", name: "Claude Default" },
        { modelId: "claude-saved", name: "Claude Saved" },
      ],
      effort: {
        supported: true,
        levels: ["low", "high"],
        default: "low",
      },
    },
    codex: {
      defaultModel: "codex-default",
      models: [
        { modelId: "codex-default", name: "Codex Default" },
        { modelId: "codex-saved", name: "Codex Saved" },
      ],
      effort: {
        supported: true,
        levels: ["medium", "high"],
        default: "medium",
      },
    },
    "opencode-go": {
      defaultModel: "opencode-go/glm-5.1",
      models: [
        { modelId: "opencode-go/glm-5.1", name: "GLM-5.1" },
      ],
      effort: {
        supported: true,
        levels: ["low", "medium", "high", "max"],
        default: "high",
      },
    },
    "claude-zai": {
      defaultModel: "zai-coding-plan/glm-5.1",
      models: [
        { modelId: "zai-coding-plan/glm-5.1", name: "GLM-5.1" },
      ],
      effort: {
        supported: true,
        levels: ["low", "medium", "high", "max"],
        default: "high",
      },
    },
    "claude-kimi": {
      defaultModel: "kimi-for-coding/k2p6",
      models: [
        { modelId: "kimi-for-coding/k2p6", name: "Kimi K2P6" },
      ],
      effort: {
        supported: true,
        levels: ["low", "medium", "high", "max"],
        default: "high",
      },
    },
    cursor: {
      defaultModel: "composer-2",
      models: [{ modelId: "composer-2", name: "Composer 2" }],
      effort: { supported: false },
    },
  };
}

function createController(state: TestState) {
  const savePerCliSettings = vi.fn((carrierId: string, cliType: CarrierCliType, selection: any) => {
    state.perCliSettings.set(`${carrierId}:${cliType}`, selection);
  });
  const updateCarrierCliType = vi.fn((carrierId: string, cliType: CarrierCliType) => {
    const config = state.configs.get(carrierId);
    const entry = state.entries.find((item) => item.carrierId === carrierId);
    if (config) config.cliType = cliType;
    if (entry) entry.cliType = cliType;
  });
  const updateModelSelection = vi.fn(async (carrierId: string, selection: ModelSelection & { direct?: boolean }) => {
    state.currentSelections[carrierId] = selection;
    const entry = state.entries.find((item) => item.carrierId === carrierId);
    if (entry) {
      entry.model = selection.model;
      entry.effort = selection.effort ?? null;
    }
  });
  const refreshAgentPanel = vi.fn();
  const syncModelConfig = vi.fn();
  const notifyStatusUpdate = vi.fn();
  const applyCliTypeModelSelectionUpdate = vi.fn(async (
    carrierId: string,
    cliType: CarrierCliType,
    _defaultCliType: CarrierCliType,
    _previousCliType: CarrierCliType | null,
    _previousSelection: unknown,
    selection: ModelSelection & { direct?: boolean },
  ) => {
    updateCarrierCliType(carrierId, cliType);
    await updateModelSelection(carrierId, selection);
  });

  const controller = new StatusOverlayController({
    getEntries: () => state.entries,
    getRegisteredOrder: () => [...state.configs.keys()],
    getRegisteredCarrierConfig: (carrierId) => state.configs.get(carrierId),
    getResolvedCliType: (carrierId) => state.configs.get(carrierId)?.cliType,
    getCurrentModelSelection: (carrierId) => state.currentSelections[carrierId],
    getAvailableModels: (cliType) => state.providers[cliType],
    getEffort: (cliType, modelId) => {
      const provider = state.providers[cliType];
      const model = provider.models.find((entry) => entry.modelId === modelId);
      return (model?.effort ?? provider.effort ?? { supported: false }) as any;
    },
    getPerCliSettings: (carrierId, cliType) => state.perCliSettings.get(`${carrierId}:${cliType}`),
    savePerCliSettings,
    updateCarrierCliType,
    applyCliTypeModelSelectionUpdate,
    refreshAgentPanel,
    syncModelConfig,
    notifyStatusUpdate,
  });

  return {
    controller,
    spies: {
      notifyStatusUpdate,
      refreshAgentPanel,
      savePerCliSettings,
      syncModelConfig,
      updateCarrierCliType,
      updateModelSelection,
      applyCliTypeModelSelectionUpdate,
    },
  };
}

describe("StatusOverlayController", () => {
  let state: TestState;

  beforeEach(() => {
    state = {
      configs: new Map([
        ["alpha", makeCarrierConfig("alpha", "claude", "claude")],
        ["beta", makeCarrierConfig("beta", "codex", "codex")],
        ["gamma", makeCarrierConfig("gamma", "cursor", "claude")],
      ]),
      currentSelections: {
        alpha: { model: "claude-current", effort: "high", direct: true },
        beta: { model: "codex-current", effort: "high" },
        gamma: { model: "composer-2" },
      },
      entries: [
        makeEntry("alpha", "claude", "claude"),
        makeEntry("beta", "codex", "codex"),
        makeEntry("gamma", "cursor", "claude"),
      ],
      perCliSettings: new Map(),
      providers: makeProviders(),
    };
  });

  it("changeCliType는 saved per-CLI 값이 있으면 saved model/effort를 반환한다", async () => {
    state.perCliSettings.set("alpha:codex", {
      model: "codex-saved",
      effort: "high",
    });
    const { controller, spies } = createController(state);

    const result = await controller.changeCliType("alpha", "codex");

    expect(result).toEqual({
      model: "codex-saved",
      effort: "high",
      isDefault: false,
    });
    expect(spies.applyCliTypeModelSelectionUpdate).toHaveBeenCalledWith("alpha", "codex", "claude", "claude", {
      model: "claude-current",
      effort: "high",
      direct: true,
    }, {
      model: "codex-saved",
      effort: "high",
      direct: undefined,
    });
    expect(spies.savePerCliSettings).not.toHaveBeenCalled();
  });

  it("changeCliType는 saved 값이 없으면 defaultModel과 기본 effort를 반환한다", async () => {
    const { controller, spies } = createController(state);

    const result = await controller.changeCliType("beta", "claude");

    expect(result).toEqual({
      model: "claude-default",
      effort: "low",
      isDefault: true,
    });
    expect(spies.applyCliTypeModelSelectionUpdate).toHaveBeenCalledWith("beta", "claude", "codex", "codex", {
      model: "codex-current",
      effort: "high",
      direct: undefined,
    }, {
      model: "claude-default",
      effort: "low",
      direct: undefined,
    });
  });

  it("changeCliTypes는 여러 캐리어에 대한 일괄 전환 결과를 반환한다", async () => {
    state.perCliSettings.set("alpha:cursor", {
      model: "composer-2",
    });
    const { controller } = createController(state);

    const results = await controller.changeCliTypes([
      { carrierId: "alpha", newCliType: "cursor" },
      { carrierId: "beta", newCliType: "claude" },
    ]);

    expect(results).toEqual([
      {
        status: "fulfilled",
        carrierId: "alpha",
        result: {
          carrierId: "alpha",
          newCliType: "cursor",
          selection: {
            model: "composer-2",
            effort: null,
            isDefault: false,
          },
        },
      },
      {
        status: "fulfilled",
        carrierId: "beta",
        result: {
          carrierId: "beta",
          newCliType: "claude",
          selection: {
            model: "claude-default",
            effort: "low",
            isDefault: true,
          },
        },
      },
    ]);
  });

  it("resetCliTypesToDefault는 UI 스냅샷과 무관하게 framework 기준으로 defaultCliType 복원을 수행한다", async () => {
    state.configs.get("gamma")!.cliType = "cursor";
    state.entries.find((entry) => entry.carrierId === "gamma")!.cliType = "claude";
    state.perCliSettings.set("gamma:claude", {
      model: "claude-saved",
      effort: "high",
    });
    const { controller, spies } = createController(state);

    const results = await controller.resetCliTypesToDefault();

    expect(results).toEqual([
      {
        status: "fulfilled",
        carrierId: "gamma",
        result: {
          carrierId: "gamma",
          newCliType: "claude",
          selection: {
            model: "claude-saved",
            effort: "high",
            isDefault: false,
          },
        },
      },
    ]);
    expect(spies.updateCarrierCliType).toHaveBeenCalledTimes(2);
    expect(state.configs.get("gamma")?.cliType).toBe("claude");
  });

  it("changeCliType 실패 시 framework cliType을 롤백하고 해당 carrier override만 복원한다", async () => {
    const { controller, spies } = createController(state);
    spies.applyCliTypeModelSelectionUpdate.mockRejectedValueOnce(new Error("boom"));

    await expect(controller.changeCliType("alpha", "codex")).rejects.toThrow("boom");

    expect(state.configs.get("alpha")?.cliType).toBe("claude");
    expect(spies.updateCarrierCliType).toHaveBeenNthCalledWith(1, "alpha", "codex");
    expect(spies.updateCarrierCliType).toHaveBeenNthCalledWith(2, "alpha", "claude");
    expect(spies.applyCliTypeModelSelectionUpdate).toHaveBeenCalledTimes(1);
  });

  it("override 저장 실패 시 model 업데이트 전에 framework cliType과 override를 롤백한다", async () => {
    const { controller, spies } = createController(state);
    spies.applyCliTypeModelSelectionUpdate.mockImplementationOnce(() => {
      throw new Error("lock timeout");
    });

    await expect(controller.changeCliType("alpha", "codex")).rejects.toThrow("lock timeout");

    expect(state.configs.get("alpha")?.cliType).toBe("claude");
    expect(spies.updateCarrierCliType).toHaveBeenNthCalledWith(1, "alpha", "codex");
    expect(spies.applyCliTypeModelSelectionUpdate).toHaveBeenCalledTimes(1);
    expect(spies.syncModelConfig).toHaveBeenCalledTimes(1);
    expect(spies.notifyStatusUpdate).toHaveBeenCalledTimes(1);
  });

  it("이전 상태가 non-default인 실패도 이전 override intent로 복원한다", async () => {
    state.configs.get("gamma")!.cliType = "cursor";
    const { controller, spies } = createController(state);
    spies.applyCliTypeModelSelectionUpdate.mockRejectedValueOnce(new Error("boom"));

    await expect(controller.changeCliType("gamma", "codex")).rejects.toThrow("boom");

    expect(state.configs.get("gamma")?.cliType).toBe("cursor");
    expect(spies.applyCliTypeModelSelectionUpdate).toHaveBeenCalledTimes(1);
  });
});
