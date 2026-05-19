import { TASKFORCE_CLI_TYPES, type FleetCoreRuntimeContext, type TaskForceCliType } from "@sbluemin/fleet-core";
import {
  createOverlayFrame,
  matchesKey,
  MIN_DEDICATED_ROWS,
  type Component,
  type FleetPtyTheme,
  type Focusable,
} from "@sbluemin/fleet-tui/pty";

import { buildModelEffortTransition } from "./model-flow.js";
import type {
  CliModelInfo,
  ModelEffort,
  ModelSelection,
  TaskForceEntry,
} from "./types.js";

export interface TaskForceOverlayOptions {
  readonly carrierDisplayName: string;
  readonly carrierId: string;
  readonly done: () => void;
  readonly requestRender: () => void;
  readonly rt: FleetCoreRuntimeContext;
  readonly theme: FleetPtyTheme;
}

type TaskForceMode = "browse" | "effort" | "model" | "saving";

const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[38;2;120;120;120m";
const ANSI_ACCENT = "\x1b[38;2;100;180;255m";
const TASKFORCE_FRAME_ROWS = 3;
const TASKFORCE_EXTRA_BODY_ROWS = 4;

export class TaskForceConfigOverlay implements Component, Focusable {
  public focused = false;
  private editCursor = 0;
  private feedbackMessage: string | null = null;
  private mode: TaskForceMode = "browse";
  private pendingModelId: string | null = null;
  private selectedIndex = 0;

  constructor(private readonly options: TaskForceOverlayOptions) {}

  handleInput(data: string): void {
    if (this.mode === "saving") return;

    if (matchesKey(data, "escape")) {
      if (this.mode === "browse") this.options.done();
      else this.cancelEdit();
      return;
    }

    if (matchesKey(data, "up")) {
      if (this.mode === "browse") this.moveSelection(-1);
      else this.moveEditCursor(-1);
      return;
    }

    if (matchesKey(data, "down")) {
      if (this.mode === "browse") this.moveSelection(1);
      else this.moveEditCursor(1);
      return;
    }

    if (this.mode === "browse" && data === "r") {
      this.resetSelectedBackend();
      return;
    }

    if (!matchesKey(data, "enter")) return;
    if (this.mode === "browse") {
      this.startModelEdit();
    } else if (this.mode === "model") {
      this.confirmModelEdit();
    } else if (this.mode === "effort") {
      this.confirmEffortEdit();
    }
  }

  invalidate(): void {}

  desiredHeight(maxRows: number): number | undefined {
    const selected = this.getSelectedEntry();
    const editRows = selected && (this.mode === "model" || this.mode === "effort") ? this.getEditOptions(selected).length : 0;
    return clampOverlayRows(maxRows, this.buildBackendEntries().length + editRows + TASKFORCE_EXTRA_BODY_ROWS + TASKFORCE_FRAME_ROWS);
  }

  render(width: number): string[] {
    const body: Array<string | { bg?: string; text: string }> = [""];
    const entries = this.buildBackendEntries();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const isSelected = i === this.selectedIndex;
      body.push({
        bg: isSelected ? this.options.rt.admiral.constants.CARRIER_BG_COLORS[entry.cliType] : undefined,
        text: this.renderEntryLine(entry, isSelected),
      });

      if (isSelected && this.mode === "model") {
        const models = this.getAvailableModels(entry.cliType).models;
        for (let j = 0; j < models.length; j++) {
          const model = models[j]!;
          const cursor = j === this.editCursor ? `${entry.color}▸${ANSI_RESET}` : " ";
          const marker = model.modelId === entry.model ? "●" : "○";
          body.push(`      ${cursor} ${marker} ${model.name ?? model.modelId}`);
        }
      }

      if (isSelected && this.mode === "effort") {
        const effortLevels = this.getEffortLevels(entry.cliType, this.pendingModelId ?? entry.model);
        for (let j = 0; j < effortLevels.length; j++) {
          const level = effortLevels[j]!;
          const cursor = j === this.editCursor ? `${entry.color}▸${ANSI_RESET}` : " ";
          const marker = level === (entry.effort ?? "") ? "●" : "○";
          body.push(`      ${cursor} ${marker} ${level}`);
        }
      }
    }

    body.push("");
    if (this.feedbackMessage) {
      const color = this.feedbackMessage.startsWith("저장 실패") ? this.options.theme.warning : this.options.theme.accent;
      body.push(color(this.feedbackMessage), "");
    }

    return createOverlayFrame({
      body,
      footer: this.getFooterHint(),
      theme: this.options.theme,
      title: `Task Force Config - ${this.options.carrierDisplayName}`,
      width,
    });
  }

  private buildBackendEntries(): TaskForceEntry[] {
    return this.getTaskForceCliTypes().map((cliType) => {
      const config = this.getBackendConfig(cliType);
      return {
        cliType,
        color: this.options.rt.admiral.constants.CARRIER_COLORS[cliType] ?? "",
        displayName: this.options.rt.admiral.constants.CLI_DISPLAY_NAMES[cliType] ?? cliType,
        effort: config.effort,
        isCustom: config.isCustom,
        model: config.model,
      };
    });
  }

  private getSelectedEntry(): TaskForceEntry | null {
    return this.buildBackendEntries()[this.selectedIndex] ?? null;
  }

  private moveSelection(delta: number): void {
    const total = this.getTaskForceCliTypes().length;
    if (total === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + total) % total;
    this.feedbackMessage = null;
    this.options.requestRender();
  }

  private moveEditCursor(delta: number): void {
    const entry = this.getSelectedEntry();
    if (!entry) return;
    const options = this.getEditOptions(entry);
    if (options.length === 0) return;
    this.editCursor = (this.editCursor + delta + options.length) % options.length;
    this.feedbackMessage = null;
    this.options.requestRender();
  }

  private startModelEdit(): void {
    const entry = this.getSelectedEntry();
    if (!entry) return;
    const models = this.getAvailableModels(entry.cliType).models;
    if (models.length === 0) {
      this.feedbackMessage = `${entry.displayName}: 선택 가능한 모델이 없습니다.`;
      this.options.requestRender();
      return;
    }
    this.mode = "model";
    this.pendingModelId = null;
    this.editCursor = Math.max(0, models.findIndex((model) => model.modelId === entry.model));
    this.feedbackMessage = null;
    this.options.requestRender();
  }

  private confirmModelEdit(): void {
    const entry = this.getSelectedEntry();
    if (!entry) return;
    const selectedModel = this.getAvailableModels(entry.cliType).models[this.editCursor];
    if (!selectedModel) return;
    const transition = buildModelEffortTransition({
      currentEffort: entry.effort,
      effortChoices: this.getEffortLevels(entry.cliType, selectedModel.modelId),
      fallbackEffort: this.getDefaultEffort(entry.cliType, selectedModel.modelId),
      selectedModel: selectedModel.modelId,
    });
    if (transition.kind === "commit") {
      void this.commitSelection(entry, transition.selection);
      return;
    }
    this.mode = "effort";
    this.pendingModelId = transition.pendingModel;
    this.editCursor = transition.cursor;
    this.options.requestRender();
  }

  private confirmEffortEdit(): void {
    const entry = this.getSelectedEntry();
    if (!entry || !this.pendingModelId) return;
    const effortLevels = this.getEffortLevels(entry.cliType, this.pendingModelId);
    const selectedEffort = effortLevels[this.editCursor];
    if (!selectedEffort) return;
    void this.commitSelection(entry, {
      effort: selectedEffort,
      model: this.pendingModelId,
    });
  }

  private resetSelectedBackend(): void {
    const entry = this.getSelectedEntry();
    if (!entry) return;
    if (!entry.isCustom) {
      this.feedbackMessage = `${entry.displayName}은 이미 origin 설정입니다.`;
      this.options.requestRender();
      return;
    }
    this.options.rt.admiral.store.resetTaskForceModelSelection(this.options.carrierId, entry.cliType);
    syncConfiguredTaskForceCarriers(this.options.rt);
    this.feedbackMessage = `${entry.displayName} 설정을 origin으로 초기화했습니다.`;
    this.options.requestRender();
  }

  private async commitSelection(entry: TaskForceEntry, selection: ModelSelection): Promise<void> {
    const modelIds = new Set(this.getAvailableModels(entry.cliType).models.map((model) => model.modelId));
    if (!modelIds.has(selection.model)) {
      this.failSelection(`${entry.displayName} 모델 선택이 유효하지 않습니다.`);
      return;
    }
    const effortLevels = this.getEffortLevels(entry.cliType, selection.model);
    const normalizedSelection: ModelSelection = { ...selection };
    if (normalizedSelection.effort && !effortLevels.includes(normalizedSelection.effort)) {
      this.failSelection(`${entry.displayName} effort 선택이 유효하지 않습니다.`);
      return;
    }
    if (effortLevels.length === 0) {
      delete normalizedSelection.effort;
    }

    this.mode = "saving";
    this.options.requestRender();
    try {
      this.options.rt.admiral.store.updateTaskForceModelSelection(this.options.carrierId, entry.cliType, normalizedSelection);
      syncConfiguredTaskForceCarriers(this.options.rt);
      this.feedbackMessage = `${entry.displayName} 설정을 저장했습니다.`;
    } catch (error) {
      this.feedbackMessage = `저장 실패: ${errorMessage(error)}`;
    } finally {
      this.resetEditState();
      this.options.requestRender();
    }
  }

  private failSelection(message: string): void {
    this.feedbackMessage = `저장 실패: ${message}`;
    this.resetEditState();
    this.options.requestRender();
  }

  private cancelEdit(): void {
    this.resetEditState();
    this.feedbackMessage = null;
    this.options.requestRender();
  }

  private renderEntryLine(entry: TaskForceEntry, isSelected: boolean): string {
    const selectedPrefix = isSelected ? `${entry.color}▸${ANSI_RESET}` : " ";
    const provider = this.getAvailableModels(entry.cliType);
    const modelName = provider.models.find((model) => model.modelId === entry.model)?.name ?? entry.model;
    const modelStr = entry.isCustom ? modelName : this.options.theme.dim(modelName);
    const effortSupported = this.getEffortLevels(entry.cliType, entry.model).length > 0;
    const effortStr = effortSupported && entry.effort
      ? ` ${this.options.theme.dim("·")} ${entry.isCustom ? entry.effort : this.options.theme.dim(entry.effort)}`
      : "";
    const configTag = entry.isCustom ? `  ${ANSI_ACCENT}(custom)${ANSI_RESET}` : `  ${ANSI_DIM}(origin)${ANSI_RESET}`;
    return `  ${selectedPrefix} ${entry.color}${entry.displayName}${ANSI_RESET}  ${modelStr}${effortStr}${configTag}`;
  }

  private getBackendConfig(cliType: TaskForceCliType): { effort: string | null; isCustom: boolean; model: string } {
    const snapshot = this.options.rt.admiral.store.readStatesSnapshot();
    const provider = this.getAvailableModels(cliType);
    try {
      const config = this.options.rt.admiral.store.getTaskForceModelConfig(this.options.carrierId, cliType, snapshot);
      const isCustom = !!snapshot.models[this.options.carrierId]?.taskforce?.[cliType];
      return {
        effort: config?.effort ?? null,
        isCustom,
        model: config?.model ?? provider.defaultModel,
      };
    } catch {
      return {
        effort: null,
        isCustom: false,
        model: provider.defaultModel,
      };
    }
  }

  private getAvailableModels(cliType: TaskForceCliType): CliModelInfo {
    try {
      const models = this.options.rt.admiral.agent.models.getCliModels(cliType).map((model) => ({
        modelId: model.id,
        name: model.name,
      }));
      const defaultModel = models[0]?.modelId ?? "default";
      return {
        defaultModel,
        effort: this.getModelEffort(cliType, defaultModel),
        models,
        name: this.options.rt.admiral.constants.CLI_DISPLAY_NAMES[cliType] ?? cliType,
      };
    } catch {
      return {
        defaultModel: "default",
        effort: { supported: false },
        models: [],
        name: this.options.rt.admiral.constants.CLI_DISPLAY_NAMES[cliType] ?? cliType,
      };
    }
  }

  private getModelEffort(cliType: TaskForceCliType, modelId: string): ModelEffort {
    try {
      const levels = this.options.rt.admiral.agent.models.getCliEffortLevels(cliType, modelId);
      if (!levels || levels.length === 0) return { supported: false };
      return {
        default: levels[0],
        levels,
        supported: true,
      };
    } catch {
      return { supported: false };
    }
  }

  private getEffortLevels(cliType: TaskForceCliType, modelId: string): string[] {
    const effort = this.getModelEffort(cliType, modelId);
    return effort.supported ? [...(effort.levels ?? [])] : [];
  }

  private getDefaultEffort(cliType: TaskForceCliType, modelId: string): string | null {
    const effort = this.getModelEffort(cliType, modelId);
    if (!effort.supported) return null;
    return effort.default ?? effort.levels?.[0] ?? null;
  }

  private getEditOptions(entry: TaskForceEntry): Array<{ value: string }> {
    if (this.mode === "model") {
      return this.getAvailableModels(entry.cliType).models.map((model) => ({ value: model.modelId }));
    }
    if (this.mode === "effort") {
      return this.getEffortLevels(entry.cliType, this.pendingModelId ?? entry.model).map((level) => ({ value: level }));
    }
    return [];
  }

  private getFooterHint(): string {
    if (this.mode === "saving") return "저장 중...";
    if (this.mode === "browse") return "↑↓ select  Enter edit  r reset  Esc close";
    return "↑↓ select  Enter confirm  Esc cancel";
  }

  private getTaskForceCliTypes(): TaskForceCliType[] {
    return [...TASKFORCE_CLI_TYPES] as TaskForceCliType[];
  }

  private resetEditState(): void {
    this.mode = "browse";
    this.pendingModelId = null;
    this.editCursor = 0;
  }
}

function syncConfiguredTaskForceCarriers(rt: FleetCoreRuntimeContext): void {
  const registeredOrder = rt.admiral.carrier.getRegisteredOrder();
  const ids = rt.admiral.store.getConfiguredTaskForceCarrierIds(registeredOrder);
  rt.admiral.carrier.setTaskForceConfiguredCarriers(ids);
  rt.admiral.carrier.notifyStatusUpdate();
}

function clampOverlayRows(maxRows: number, cardRows: number): number {
  const maxFleetRows = Math.max(0, maxRows - MIN_DEDICATED_ROWS);
  return Math.min(maxFleetRows, Math.max(0, cardRows));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
