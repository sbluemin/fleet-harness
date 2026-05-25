import type { CarrierConfig } from "./types.js";
import type {
  CarrierCliType,
  CarrierOverlayCallbacks,
  CarrierStatusEntry,
  CliModelInfo,
  ModelEffort,
  CliTypeChangeResult,
  CliTypeChangeSettledResult,
  ModelSelection,
  ResolvedCliSelection,
} from "./types.js";

interface StoredCliSelection {
  model?: string;
  effort?: string;
  direct?: boolean;
}

interface StatusOverlayControllerDeps {
  getEntries: () => CarrierStatusEntry[];
  getRegisteredOrder: () => string[];
  getCarrierConfig: (carrierId: string) => CarrierConfig | undefined;
  getResolvedCliType: (carrierId: string) => CarrierCliType | undefined;
  getCurrentModelSelection: (carrierId: string) => (ModelSelection & { direct?: boolean }) | undefined;
  getAvailableModels: (cliType: CarrierCliType) => CliModelInfo;
  getEffort?: (cliType: CarrierCliType, modelId: string) => ModelEffort | null;
  getPerCliSettings: (carrierId: string, cliType: CarrierCliType) => StoredCliSelection | undefined;
  savePerCliSettings: (carrierId: string, cliType: CarrierCliType, selection: StoredCliSelection) => void;
  updateCarrierCliType: (carrierId: string, cliType: CarrierCliType) => void;
  applyCliTypeModelSelectionUpdate: (
    carrierId: string,
    newCliType: CarrierCliType,
    defaultCliType: CarrierCliType,
    previousCliType: CarrierCliType | null,
    previousSelection: StoredCliSelection | undefined,
    selection: ModelSelection & { direct?: boolean },
  ) => Promise<void>;
  refreshAgentPanel: () => void;
  syncModelConfig: () => void;
  notifyStatusUpdate: () => void;
}

export class StatusOverlayController implements Pick<
  CarrierOverlayCallbacks,
  "changeCliType" | "changeCliTypes" | "resetCliTypesToDefault"
> {
  private readonly deps: StatusOverlayControllerDeps;

  constructor(deps: StatusOverlayControllerDeps) {
    this.deps = deps;
  }

  async changeCliType(
    carrierId: string,
    newCliType: CarrierCliType,
  ): Promise<ResolvedCliSelection> {
    const result = await this.applyCliTypeChange(carrierId, newCliType);
    return result.selection;
  }

  async changeCliTypes(
    updates: Array<{ carrierId: string; newCliType: CarrierCliType }>,
  ): Promise<CliTypeChangeSettledResult[]> {
    const normalized = this.normalizeCliUpdates(updates);
    const settled = await Promise.allSettled(
      normalized.map(({ carrierId, newCliType }) => this.applyCliTypeChange(carrierId, newCliType)),
    );
    return settled.map((outcome, index) => {
      const { carrierId } = normalized[index]!;
      if (outcome.status === "fulfilled") {
        return { status: "fulfilled", carrierId, result: outcome.value };
      }
      return {
        status: "rejected",
        carrierId,
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      };
    });
  }

  async resetCliTypesToDefault(): Promise<CliTypeChangeSettledResult[]> {
    const updates = this.deps.getRegisteredOrder()
      .map((carrierId) => {
        const config = this.deps.getCarrierConfig(carrierId);
        const resolvedCliType = this.deps.getResolvedCliType(carrierId);
        if (!config || !resolvedCliType || resolvedCliType === config.defaultCliType) {
          return null;
        }
        return {
          carrierId,
          newCliType: config.defaultCliType as CarrierCliType,
        };
      })
      .filter((update): update is { carrierId: string; newCliType: CarrierCliType } => update !== null);
    return this.changeCliTypes(updates);
  }

  private async applyCliTypeChange(
    carrierId: string,
    newCliType: CarrierCliType,
  ): Promise<CliTypeChangeResult> {
    const currentConfig = this.deps.getCarrierConfig(carrierId);
    const currentCliType = this.deps.getResolvedCliType(carrierId);
    const defaultCliType = currentConfig?.defaultCliType as CarrierCliType | undefined;
    let cliTypeChanged = false;
    try {
      const previousTopLevelSelection = currentCliType
        ? this.deps.getCurrentModelSelection(carrierId)
        : undefined;
      const previousSelectionForStore: StoredCliSelection | undefined = currentCliType && previousTopLevelSelection
        ? {
          model: previousTopLevelSelection.model,
          effort: previousTopLevelSelection.effort,
          direct: previousTopLevelSelection.direct,
        }
        : undefined;

      this.deps.updateCarrierCliType(carrierId, newCliType);
      cliTypeChanged = true;
      this.deps.refreshAgentPanel();
      const resolved = this.resolveCliSelection(carrierId, newCliType);
      await this.deps.applyCliTypeModelSelectionUpdate(
        carrierId,
        newCliType,
        defaultCliType ?? newCliType,
        currentCliType ?? null,
        previousSelectionForStore,
        {
          model: resolved.model,
          effort: resolved.effort ?? undefined,
          direct: this.deps.getPerCliSettings(carrierId, newCliType)?.direct,
        },
      );
      return {
        carrierId,
        newCliType,
        selection: resolved,
      };
    } catch (error) {
      this.rollbackCliTypeChange(carrierId, currentCliType, defaultCliType, cliTypeChanged);
      throw error;
    } finally {
      this.deps.syncModelConfig();
      this.deps.notifyStatusUpdate();
    }
  }

  private resolveCliSelection(
    carrierId: string,
    cliType: CarrierCliType,
  ): ResolvedCliSelection {
    const saved = this.deps.getPerCliSettings(carrierId, cliType);
    const provider = this.deps.getAvailableModels(cliType);
    const hasSavedModel = !!(saved?.model && provider.models.some((model) => model.modelId === saved.model));
    const resolvedModel = hasSavedModel ? saved!.model! : provider.defaultModel;
    const effort = this.getModelEffort(cliType, resolvedModel, provider);
    const effortLevels = effort?.levels ?? [];
    const defaultEffort = effort?.default ?? null;
    const resolvedEffort = saved?.effort && effortLevels.includes(saved.effort)
      ? saved.effort
      : defaultEffort;

    return {
      model: resolvedModel,
      effort: resolvedEffort,
      isDefault: !hasSavedModel,
    };
  }

  private getModelEffort(
    cliType: CarrierCliType,
    modelId: string,
    provider: CliModelInfo,
  ): ModelEffort | null {
    const fromAgent = this.deps.getEffort?.(cliType, modelId);
    if (fromAgent) return normalizeEffort(fromAgent);

    const model = provider.models.find((item) => item.modelId === modelId);
    if (model?.effort) return normalizeEffort(model.effort);
    return null;
  }

  private rollbackCliTypeChange(
    carrierId: string,
    currentCliType: CarrierCliType | undefined,
    defaultCliType: CarrierCliType | undefined,
    cliTypeChanged: boolean,
  ): void {
    if (!cliTypeChanged || !currentCliType) return;
    try {
      this.deps.updateCarrierCliType(carrierId, currentCliType);
      this.deps.refreshAgentPanel();
    } catch {
      // 원래 실패를 보존하기 위해 best-effort rollback 실패는 삼킵니다.
    }
  }

  private normalizeCliUpdates(
    updates: Array<{ carrierId: string; newCliType: CarrierCliType }>,
  ): Array<{ carrierId: string; newCliType: CarrierCliType }> {
    const deduped = new Map<string, CarrierCliType>();
    for (const update of updates) {
      deduped.set(update.carrierId, update.newCliType);
    }
    return [...deduped.entries()].map(([carrierId, newCliType]) => ({ carrierId, newCliType }));
  }
}

function normalizeEffort(
  effort: ModelEffort,
): ModelEffort | null {
  if (!effort.supported) return null;
  const levels = effort.levels ?? [];
  if (levels.length === 0) return null;
  return {
    supported: true,
    levels,
    default: effort.default && levels.includes(effort.default) ? effort.default : levels[0],
  };
}
