import type { CarrierConfig } from "./types.js";
import type {
  CarrierCliType,
  CarrierOverlayCallbacks,
  CarrierStatusEntry,
  CliModelInfo,
  CliTypeChangeResult,
  ModelSelection,
  ResolvedCliSelection,
} from "./overlay-types.js";

interface StoredCliSelection {
  model?: string;
  effort?: string;
  direct?: boolean;
}

interface StatusOverlayControllerDeps {
  getEntries: () => CarrierStatusEntry[];
  getRegisteredOrder: () => string[];
  getRegisteredCarrierConfig: (carrierId: string) => CarrierConfig | undefined;
  getCurrentModelSelection: (carrierId: string) => (ModelSelection & { direct?: boolean }) | undefined;
  getAvailableModels: (cliType: CarrierCliType) => CliModelInfo;
  getPerCliSettings: (carrierId: string, cliType: CarrierCliType) => StoredCliSelection | undefined;
  savePerCliSettings: (carrierId: string, cliType: CarrierCliType, selection: StoredCliSelection) => void;
  updateCarrierCliType: (carrierId: string, cliType: CarrierCliType) => void;
  updateModelSelection: (
    carrierId: string,
    selection: ModelSelection & { direct?: boolean },
  ) => Promise<void>;
  refreshAgentPanel: () => void;
  syncModelConfig: () => void;
  notifyStatusUpdate: () => void;
  updateCliTypeOverride: (
    carrierId: string,
    cliType: CarrierCliType,
    defaultCliType: CarrierCliType,
  ) => void;
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
  ): Promise<CliTypeChangeResult[]> {
    const normalized = this.normalizeCliUpdates(updates);
    return Promise.all(
      normalized.map(({ carrierId, newCliType }) => this.applyCliTypeChange(carrierId, newCliType)),
    );
  }

  async resetCliTypesToDefault(): Promise<CliTypeChangeResult[]> {
    const updates = this.deps.getRegisteredOrder()
      .map((carrierId) => {
        const config = this.deps.getRegisteredCarrierConfig(carrierId);
        if (!config || config.cliType === config.defaultCliType) {
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
    const currentConfig = this.deps.getRegisteredCarrierConfig(carrierId);
    const currentCliType = currentConfig?.cliType as CarrierCliType | undefined;
    const defaultCliType = currentConfig?.defaultCliType as CarrierCliType | undefined;
    let cliTypeChanged = false;
    try {
      if (currentCliType) {
        const currentSelection = this.deps.getCurrentModelSelection(carrierId);
        if (currentSelection) {
          this.deps.savePerCliSettings(carrierId, currentCliType, {
            model: currentSelection.model,
            effort: currentSelection.effort,
            direct: currentSelection.direct,
          });
        }
      }

      this.deps.updateCarrierCliType(carrierId, newCliType);
      cliTypeChanged = true;
      this.deps.refreshAgentPanel();
      this.persistCarrierCliOverride(carrierId, newCliType, defaultCliType);

      const resolved = this.resolveCliSelection(carrierId, newCliType);
      await this.deps.updateModelSelection(carrierId, {
        model: resolved.model,
        effort: resolved.effort ?? undefined,
        direct: this.deps.getPerCliSettings(carrierId, newCliType)?.direct,
      });
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
    const effortLevels = provider.reasoningEffort.levels ?? [];
    const defaultEffort = provider.reasoningEffort.default ?? null;
    const resolvedEffort = saved?.effort && effortLevels.includes(saved.effort)
      ? saved.effort
      : defaultEffort;

    return {
      model: hasSavedModel ? saved!.model! : provider.defaultModel,
      effort: resolvedEffort,
      isDefault: !hasSavedModel,
    };
  }

  private persistCarrierCliOverride(
    carrierId: string,
    cliType: CarrierCliType,
    defaultCliType: CarrierCliType | undefined,
  ): void {
    if (!defaultCliType) return;
    this.deps.updateCliTypeOverride(carrierId, cliType, defaultCliType);
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
      this.persistCarrierCliOverride(carrierId, currentCliType, defaultCliType);
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
