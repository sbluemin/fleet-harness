import {
  CLI_DISPLAY_NAMES,
  TASKFORCE_CLI_TYPES,
  getTaskForceModelConfig,
  notifyStatusUpdate,
  readCarriersSnapshot,
  removeTaskForceBackend,
  setTaskForceBackend,
  type CarrierRuntime,
  type TaskForceCliType,
} from "@dotobokuri/fleet-carriers";
import {
  PROVIDER_ANSI_COLORS,
} from "../../styles/carriers.js";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type FleetPtyTheme,
  type Focusable,
} from "../../controls/index.js";
import type { MenuPanel } from "../menu/panel-stack.js";
import { maxVisibleWidth, padEndVisible } from "../layout.js";
import { centerText } from "../welcome.js";

import { buildModelEffortTransition } from "./types.js";
import { getAvailableModels, getModelEffort } from "./types.js";
import type {
  CliModelInfo,
  ModelEffort,
  ModelSelection,
  TaskForceEntry,
} from "./types.js";

export interface TaskForceOverlayOptions {
  readonly carrierRuntime: CarrierRuntime;
  readonly carrierDisplayName: string;
  readonly carrierId: string;
  readonly done: () => void;
  readonly requestRender: () => void;
  readonly theme: FleetPtyTheme;
}

type TaskForceMode = "actions" | "browse" | "effort" | "model" | "saving";

interface TaskForceCellLine {
  readonly bg?: string;
  readonly text: string;
}

interface TaskForceEntryLineMetrics {
  readonly detailWidth: number;
  readonly displayNameWidth: number;
}

type TaskForceDisplayLine =
  | { readonly kind: "blank" }
  | { readonly kind: "cell"; readonly line: TaskForceCellLine }
  | { readonly kind: "center"; readonly text: string };

const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[38;2;120;120;120m";
const ANSI_ACCENT = "\x1b[38;2;100;180;255m";
const INDENT = "    ";
const TASKFORCE_EXTRA_BODY_ROWS = 5;
const MIN_CELL_WIDTH = 40;

export class RosterTaskForcePanelSurface implements Component, Focusable {
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

    if (!matchesKey(data, "enter")) return;
    if (this.mode === "browse") {
      this.mode = "actions";
      this.editCursor = 0;
      this.feedbackMessage = null;
      this.options.requestRender();
    } else if (this.mode === "actions") {
      this.runAction();
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
    return clampOverlayRows(maxRows, this.buildBackendEntries().length + editRows + TASKFORCE_EXTRA_BODY_ROWS);
  }

  render(width: number): string[] {
    const entries = this.buildBackendEntries();
    const entryMetrics = this.resolveEntryLineMetrics(entries);
    const body: TaskForceDisplayLine[] = [
      { kind: "center", text: this.options.theme.dim("Carrier Roster / TaskForce") },
      { kind: "center", text: this.options.theme.accent(`TaskForce - ${this.options.carrierDisplayName}`) },
      { kind: "blank" },
    ];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const isSelected = i === this.selectedIndex;
      body.push({
        kind: "cell",
        line: {
          text: withIndent(this.renderEntryLine(entry, entryMetrics, isSelected)),
        },
      });

      if (isSelected && this.mode === "model") {
        const models = this.getAvailableModels(entry.cliType).models;
        for (let j = 0; j < models.length; j++) {
          const model = models[j]!;
          const cursor = j === this.editCursor ? `${entry.color}▸${ANSI_RESET}` : " ";
          const marker = model.modelId === entry.model ? "●" : "○";
          body.push(toIndentedCellLine(`      ${cursor} ${marker} ${model.name ?? model.modelId}`));
        }
      }

      if (isSelected && this.mode === "effort") {
        const effortLevels = this.getEffortLevels(entry.cliType, this.pendingModelId ?? entry.model);
        for (let j = 0; j < effortLevels.length; j++) {
          const level = effortLevels[j]!;
          const cursor = j === this.editCursor ? `${entry.color}▸${ANSI_RESET}` : " ";
          const marker = level === (entry.effort ?? "") ? "●" : "○";
          body.push(toIndentedCellLine(`      ${cursor} ${marker} ${level}`));
        }
      }

      if (isSelected && this.mode === "actions") {
        const actions = this.getSelectedActions(entry);
        body.push(toIndentedCellLine(`      ${ANSI_ACCENT}Backend Actions${ANSI_RESET}`));
        for (let j = 0; j < actions.length; j++) {
          const action = actions[j]!;
          const cursor = j === this.editCursor ? `${entry.color}▸${ANSI_RESET}` : " ";
          body.push(toIndentedCellLine(`      ${cursor} ${action}`));
        }
      }
    }

    body.push({ kind: "blank" });
    if (this.feedbackMessage) {
      const color = isWarningFeedback(this.feedbackMessage) ? this.options.theme.warning : this.options.theme.accent;
      body.push({ kind: "center", text: color(this.feedbackMessage) }, { kind: "blank" });
    }

    body.push({ kind: "center", text: this.options.theme.dim(this.getFooterHint()) });
    return renderDisplayLines(body, width);
  }

  private buildBackendEntries(): TaskForceEntry[] {
    return this.getTaskForceCliTypes().map((cliType) => {
      const config = this.getBackendConfig(cliType);
      return {
        cliType,
        color: PROVIDER_ANSI_COLORS[cliType] ?? "",
        displayName: CLI_DISPLAY_NAMES[cliType] ?? cliType,
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

  private runAction(): void {
    const entry = this.getSelectedEntry();
    if (!entry) return;
    const actions = this.getSelectedActions(entry);
    const action = actions[this.editCursor];
    this.mode = "browse";
    this.editCursor = 0;
    if (action === "Edit Model") {
      this.startModelEdit();
      return;
    }
    if (action === "Reset to Origin") {
      this.resetSelectedBackend();
      return;
    }
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
    removeTaskForceBackend(this.options.carrierId, entry.cliType);
    notifyStatusUpdate(this.options.carrierRuntime.registry);
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
      setTaskForceBackend(this.options.carrierRuntime.registry, this.options.carrierId, entry.cliType, normalizedSelection);
      notifyStatusUpdate(this.options.carrierRuntime.registry);
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

  private resolveEntryLineMetrics(entries: readonly TaskForceEntry[]): TaskForceEntryLineMetrics {
    return {
      detailWidth: maxVisibleWidth(entries.map((entry) => this.formatEntryDetail(entry))),
      displayNameWidth: maxVisibleWidth(entries.map((entry) => entry.displayName)),
    };
  }

  private renderEntryLine(entry: TaskForceEntry, metrics: TaskForceEntryLineMetrics, isSelected: boolean): string {
    const selectedPrefix = isSelected ? `${entry.color}▸${ANSI_RESET}` : " ";
    const nameCell = padEndVisible(`${entry.color}${entry.displayName}${ANSI_RESET}`, metrics.displayNameWidth);
    const detailCell = padEndVisible(this.formatEntryDetail(entry), metrics.detailWidth);
    const configTag = entry.isCustom ? `  ${ANSI_ACCENT}(custom)${ANSI_RESET}` : `  ${ANSI_DIM}(origin)${ANSI_RESET}`;
    return `  ${selectedPrefix} ${nameCell}  ${detailCell}${configTag}`;
  }

  private formatEntryDetail(entry: TaskForceEntry): string {
    const provider = this.getAvailableModels(entry.cliType);
    const modelName = provider.models.find((model) => model.modelId === entry.model)?.name ?? entry.model;
    const modelStr = entry.isCustom ? modelName : this.options.theme.dim(modelName);
    const effortSupported = this.getEffortLevels(entry.cliType, entry.model).length > 0;
    const effortStr = effortSupported && entry.effort
      ? ` ${this.options.theme.dim("·")} ${entry.isCustom ? entry.effort : this.options.theme.dim(entry.effort)}`
      : "";
    return `${modelStr}${effortStr}`;
  }

  private getBackendConfig(cliType: TaskForceCliType): { effort: string | null; isCustom: boolean; model: string } {
    const snapshot = readCarriersSnapshot();
    const provider = this.getAvailableModels(cliType);
    try {
      const config = getTaskForceModelConfig(this.options.carrierId, cliType, snapshot);
      const isCustom = !!snapshot.carriers[this.options.carrierId]?.taskforce?.[cliType];
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
    return getAvailableModels(cliType);
  }

  private getModelEffort(cliType: TaskForceCliType, modelId: string): ModelEffort {
    return getModelEffort(cliType, modelId);
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
    if (this.mode === "actions") {
      return this.getSelectedActions(entry).map((label) => ({ value: label }));
    }
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
    if (this.mode === "browse") return "↑↓ select  Enter actions  Esc back";
    if (this.mode === "actions") return "↑↓ select  Enter run  Esc back";
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

  private getSelectedActions(entry: TaskForceEntry): readonly string[] {
    return entry.isCustom ? ["Edit Model", "Reset to Origin"] : ["Edit Model"];
  }
}

export function createTaskForcePanel(options: TaskForceOverlayOptions): MenuPanel {
  const component = new RosterTaskForcePanelSurface(options);
  return {
    id: "carrier-roster:taskforce",
    title: "TaskForce",
    handleInput(data): boolean {
      component.handleInput(data);
      return true;
    },
    render({ width }): readonly string[] {
      return component.render(width);
    },
  };
}

function clampOverlayRows(maxRows: number, cardRows: number): number {
  return Math.min(Math.max(0, maxRows), Math.max(0, cardRows));
}

function renderDisplayLines(lines: readonly TaskForceDisplayLine[], width: number): string[] {
  const cellWidth = resolveCellWidth(lines);
  return lines.map((line) => {
    if (line.kind === "blank") {
      return "";
    }
    if (line.kind === "center") {
      return centerText(line.text, width);
    }
    return renderCellLine(line.line, cellWidth, width);
  });
}

function resolveCellWidth(lines: readonly TaskForceDisplayLine[]): number {
  const lineWidths = lines
    .filter((line): line is Extract<TaskForceDisplayLine, { readonly kind: "cell" }> => line.kind === "cell")
    .map((line) => visibleWidth(line.line.text));
  return Math.max(MIN_CELL_WIDTH, ...lineWidths);
}

function renderCellLine(line: TaskForceCellLine, cellWidth: number, width: number): string {
  const padded = padEndVisible(truncateToWidth(line.text, cellWidth), cellWidth);
  return centerText(applyLineBg(padded, line.bg), width);
}

function toCellLine(text: string): TaskForceDisplayLine {
  return {
    kind: "cell",
    line: { text },
  };
}

function toIndentedCellLine(text: string): TaskForceDisplayLine {
  return toCellLine(withIndent(text));
}

function withIndent(text: string): string {
  return `${INDENT}${text}`;
}

function applyLineBg(line: string, bg: string | undefined): string {
  if (!bg) return line;
  return `${bg}${line.replaceAll(ANSI_RESET, `${ANSI_RESET}${bg}`)}${ANSI_RESET}`;
}

function isWarningFeedback(message: string): boolean {
  return message.startsWith("저장 실패") || message.startsWith("경고:");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
