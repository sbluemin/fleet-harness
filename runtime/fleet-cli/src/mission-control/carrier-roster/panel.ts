import {
  CLI_DISPLAY_NAMES,
  StatusOverlayController,
  TASKFORCE_CLI_TYPES,
  applyAgentCliTypeSelectionUpdate,
  getCarrierSourceDisplayName,
  getAgentCliSelection,
  getCarrierConfig,
  getRegisteredOrder,
  notifyStatusUpdate,
  normalizeCarrierDisplayNameInput,
  resolveAgentCliType,
  resolveCarrierDisplayName,
  sanitizeCarrierDisplayName,
  saveAgentCliSelection,
  updateAgentCliSelection,
  updateCarrierCliType,
  updateCarrierDisplayName,
  type AgentCliSelection,
} from "@dotobokuri/fleet-carriers";
import {
  isPrintable,
  matchesKey,
  type Component,
  type Focusable,
} from "../../controls/index.js";

import { buildModelEffortTransition } from "./types.js";
import { getCarrierActions } from "./types.js";
import { getAvailableModels, getModelEffort } from "./types.js";
import { handleCarrierStatusOverlayInput } from "./input.js";
import {
  clampCarrierStatusOverlayRows,
  estimateCarrierStatusRows,
  getCarrierStatusFocusLine,
  renderCarrierStatusOverlay,
} from "./renderer.js";
import type { CarrierStatusOverlayOptions, EntrySnapshot, RenameState } from "./types.js";
import {
  buildStatusEntries,
  buildStatusOverlayViewModel,
  resolveSelectedCarrierId,
} from "./view-model.js";
import type {
  BatchCliChoice,
  CarrierCliType,
  CarrierStatusEntry,
  CliModelInfo,
  CliTypeChangeSettledResult,
  CliTypeChoice,
  ModelEffort,
  ModelSelection,
  OverlayState,
  ResolvedCliSelection,
} from "./types.js";

const ROSTER_ACTIONS_ID = "__roster_actions__";
const ROSTER_ACTION_LABELS = [
  "Batch CLI Switch",
  "Reset CLI Types to Default",
] as const;

export class CarrierStatusOverlay implements Component, Focusable {
  public focused = false;
  private expandedCarrierId: string | null = null;
  private feedbackMessage: string | null = null;
  private renameState: RenameState | null = null;
  private selectedCarrierId: string | null = null;
  private state: OverlayState = { kind: "browse" };

  constructor(private readonly options: CarrierStatusOverlayOptions) {
    this.selectedCarrierId = this.getEntries()[0]?.carrierId ?? null;
  }

  handleInput(data: string): void {
    handleCarrierStatusOverlayInput(data, {
      renameState: this.renameState,
      state: this.state,
    }, {
      cancelEdit: () => this.cancelEdit(),
      confirmBatchCliFromEdit: () => this.confirmBatchCliFromEdit(),
      confirmBatchCliToEdit: () => this.confirmBatchCliToEdit(),
      confirmCliTypeEdit: () => this.confirmCliTypeEdit(),
      confirmEffortEdit: () => this.confirmEffortEdit(),
      confirmModelEdit: () => this.confirmModelEdit(),
      done: this.options.done,
      handleRenameInput: (input) => this.handleRenameInput(input),
      moveEditCursor: (delta) => this.moveEditCursor(delta),
      moveSelection: (delta) => this.moveSelection(delta),
      openActions: () => this.openActions(),
      openTaskForce: () => this.openTaskForce(),
      resetCliTypesToDefault: () => this.resetCliTypesToDefault(),
      runAction: () => this.runAction(),
      startBatchCliFromEdit: () => this.startBatchCliFromEdit(),
      startCliTypeEdit: () => this.startCliTypeEdit(),
      startModelEdit: () => this.startModelEdit(),
      startRenameEdit: () => this.startRenameEdit(),
      toggleDetails: () => this.toggleDetails(),
    });
  }

  invalidate(): void {}

  desiredHeight(maxRows: number): number | undefined {
    return clampCarrierStatusOverlayRows(
      maxRows,
      estimateCarrierStatusRows(this.getRenderModel(), this.getRenderDeps()) + 4,
    );
  }

  render(width: number): string[] {
    return renderCarrierStatusOverlay(width, this.getRenderModel(), this.getRenderDeps());
  }

  getFocusLine(width: number): number | undefined {
    return getCarrierStatusFocusLine(width, this.getRenderModel(), this.getRenderDeps());
  }

  private getEntries(): CarrierStatusEntry[] {
    return buildStatusEntries(this.options.carrierRuntime);
  }

  private getFlatEntries(): CarrierStatusEntry[] {
    return this.getViewModel().flatEntries;
  }

  private getSelectedEntry(): CarrierStatusEntry | null {
    if (this.selectedCarrierId === ROSTER_ACTIONS_ID) return null;
    const flatEntries = this.getFlatEntries();
    const selectedCarrierId = this.syncSelectedCarrierId(flatEntries);
    return selectedCarrierId ? flatEntries.find((entry) => entry.carrierId === selectedCarrierId) ?? null : null;
  }

  private getRenderDeps() {
    return {
      getAvailableModels: (cliType: CarrierCliType) => this.getAvailableModels(cliType),
      getBatchCliChoices: (excludeCli?: CarrierCliType) => this.getBatchCliChoices(excludeCli),
      getDefaultEffort: (cliType: CarrierCliType, modelId: string) => this.getDefaultEffort(cliType, modelId),
      getModelEffortLevels: (cliType: CarrierCliType, modelId: string) => this.getModelEffortLevels(cliType, modelId),
      theme: this.options.theme,
    };
  }

  private getRenderModel() {
    return {
      expandedCarrierId: this.expandedCarrierId,
      feedbackMessage: this.feedbackMessage,
      renameState: this.renameState,
      state: this.state,
      viewModel: this.getViewModel(),
    };
  }

  private getViewModel() {
    const selectedVirtualRow = this.selectedCarrierId === ROSTER_ACTIONS_ID;
    const viewModel = buildStatusOverlayViewModel(this.getEntries(), this.selectedCarrierId);
    this.selectedCarrierId = selectedVirtualRow ? ROSTER_ACTIONS_ID : viewModel.selectedCarrierId;
    return {
      ...viewModel,
      selectedCarrierId: this.selectedCarrierId,
    };
  }

  private syncSelectedCarrierId(entries: readonly CarrierStatusEntry[]): string | null {
    this.selectedCarrierId = resolveSelectedCarrierId(entries, this.selectedCarrierId);
    return this.selectedCarrierId;
  }

  private moveSelection(delta: number): void {
    const flatEntries = this.getFlatEntries();
    const ids = [...flatEntries.map((entry) => entry.carrierId), ROSTER_ACTIONS_ID];
    if (ids.length === 0) return;
    const selectedCarrierId = this.selectedCarrierId === ROSTER_ACTIONS_ID ? ROSTER_ACTIONS_ID : this.syncSelectedCarrierId(flatEntries);
    const currentIndex = Math.max(0, ids.findIndex((carrierId) => carrierId === selectedCarrierId));
    this.selectedCarrierId = ids[(currentIndex + delta + ids.length) % ids.length] ?? null;
    this.feedbackMessage = null;
    this.options.requestRender();
  }

  private moveEditCursor(delta: number): void {
    const cursorState = this.state;
    const total = this.getActionCount(cursorState.kind);
    if (total === 0 || !("cursor" in cursorState)) return;
    if (total === 0) return;
    this.state = {
      ...cursorState,
      cursor: (cursorState.cursor + delta + total) % total,
    };
    this.feedbackMessage = null;
    this.options.requestRender();
  }

  private getActionCount(kind: OverlayState["kind"]): number {
    if (kind === "carrierActions") return getCarrierActions(this.getSelectedEntry()).length;
    if (kind === "rosterActions") return ROSTER_ACTION_LABELS.length;
    const cursorState = this.state;
    return "choices" in cursorState ? cursorState.choices.length : 0;
  }

  private openActions(): void {
    if (this.selectedCarrierId === ROSTER_ACTIONS_ID) {
      this.state = { cursor: 0, kind: "rosterActions" };
      this.feedbackMessage = null;
      this.options.requestRender();
      return;
    }
    if (!this.getSelectedEntry()) return;
    this.state = { cursor: 0, kind: "carrierActions" };
    this.feedbackMessage = null;
    this.options.requestRender();
  }

  private runAction(): void {
    const cursorState = this.state;
    if (cursorState.kind === "carrierActions") {
      this.runCarrierAction(cursorState.cursor);
      return;
    }
    if (cursorState.kind === "rosterActions") {
      this.runRosterAction(cursorState.cursor);
    }
  }

  private runCarrierAction(index: number): void {
    this.state = { kind: "browse" };
    switch (getCarrierActions(this.getSelectedEntry())[index]) {
      case "agent-cli":
        this.startCliTypeEdit();
        return;
      case "model":
        this.startModelEdit();
        return;
      case "taskforce":
        this.openTaskForce();
        return;
      case "rename":
        this.startRenameEdit();
        return;
      case "details":
        this.toggleDetails();
        return;
      default:
        this.options.requestRender();
    }
  }

  private runRosterAction(index: number): void {
    this.state = { kind: "browse" };
    if (index === 0) {
      this.startBatchCliFromEdit();
      return;
    }
    if (index === 1) {
      this.resetCliTypesToDefault();
      return;
    }
    this.options.requestRender();
  }

  private toggleDetails(): void {
    const entry = this.getSelectedEntry();
    if (!entry) return;
    this.expandedCarrierId = this.expandedCarrierId === entry.carrierId ? null : entry.carrierId;
    this.feedbackMessage = null;
    this.options.requestRender();
  }

  private startModelEdit(): void {
    const entry = this.getSelectedEntry();
    if (!entry) return;
    const choices = this.getAvailableModels(entry.cliType).models.map((model) => model.modelId);
    if (choices.length === 0) {
      this.feedbackMessage = `${entry.displayName}: 선택 가능한 모델이 없습니다.`;
      this.options.requestRender();
      return;
    }
    this.state = {
      carrierId: entry.carrierId,
      choices,
      cursor: Math.max(0, choices.findIndex((modelId) => modelId === entry.model)),
      kind: "model",
    };
    this.feedbackMessage = null;
    this.options.requestRender();
  }

  private confirmModelEdit(): void {
    if (this.state.kind !== "model") return;
    const entry = this.getEntryById(this.state.carrierId);
    const selectedModel = this.state.choices[this.state.cursor];
    if (!entry || !selectedModel) return;
    const transition = buildModelEffortTransition({
      currentEffort: entry.effort,
      effortChoices: this.getModelEffortLevels(entry.cliType, selectedModel),
      fallbackEffort: this.getDefaultEffort(entry.cliType, selectedModel),
      selectedModel,
    });
    if (transition.kind === "commit") {
      void this.commitSelection(entry, transition.selection);
      return;
    }
    this.state = {
      carrierId: entry.carrierId,
      choices: transition.choices,
      cursor: transition.cursor,
      kind: "effort",
      pendingModel: transition.pendingModel,
    };
    this.options.requestRender();
  }

  private confirmEffortEdit(): void {
    if (this.state.kind !== "effort") return;
    const entry = this.getEntryById(this.state.carrierId);
    const selectedEffort = this.state.choices[this.state.cursor];
    if (!entry || !selectedEffort) return;
    void this.commitSelection(entry, {
      effort: selectedEffort,
      model: this.state.pendingModel,
    });
  }

  private async commitSelection(entry: CarrierStatusEntry, selection: ModelSelection): Promise<void> {
    const previous = this.captureEntrySnapshot(entry);
    this.state = { kind: "saving" };
    this.applyModelSelection(entry, selection);
    this.options.requestRender();
    try {
      await updateAgentCliSelection(entry.carrierId, entry.cliType, selection);
      notifyStatusUpdate(this.options.carrierRuntime.registry);
      this.feedbackMessage = `${entry.displayName} 모델 설정을 저장했습니다.`;
    } catch (error) {
      this.restoreEntrySnapshot(entry, previous);
      this.feedbackMessage = `저장 실패: ${errorMessage(error)}`;
    } finally {
      this.state = { kind: "browse" };
      this.options.requestRender();
    }
  }

  private applyModelSelection(entry: CarrierStatusEntry, selection: ModelSelection): void {
    entry.model = selection.model;
    entry.effort = selection.effort ?? null;
    entry.isDefault = false;
  }

  private startCliTypeEdit(): void {
    const entry = this.getSelectedEntry();
    if (!entry) return;
    const choices = this.getAllCliTypes().map((cliType): CliTypeChoice => ({
      label: this.getCliDisplayName(cliType),
      value: cliType,
    }));
    this.state = {
      carrierId: entry.carrierId,
      choices,
      cursor: Math.max(0, choices.findIndex((choice) => choice.value === entry.cliType)),
      kind: "cliType",
    };
    this.feedbackMessage = null;
    this.options.requestRender();
  }

  private confirmCliTypeEdit(): void {
    if (this.state.kind !== "cliType") return;
    const entry = this.getEntryById(this.state.carrierId);
    const selected = this.state.choices[this.state.cursor];
    if (!entry || !selected) return;
    if (selected.value === entry.cliType) {
      this.state = { kind: "browse" };
      this.options.requestRender();
      return;
    }

    const previous = this.captureEntrySnapshot(entry);
    const nextCliType = selected.value;
    this.applyResolvedSelection(entry, nextCliType, this.getDefaultResolvedCliSelection(nextCliType));
    this.state = { kind: "saving" };
    this.feedbackMessage = `${entry.displayName} → ${this.getCliDisplayName(nextCliType)} 전환 중...`;
    this.options.requestRender();
    void this.createStatusOverlayController().changeCliType(entry.carrierId, nextCliType).then((resolved) => {
      this.applyResolvedSelection(entry, nextCliType, resolved);
      this.feedbackMessage = `${entry.displayName} → ${this.getCliDisplayName(nextCliType)} 전환 완료`;
    }).catch(() => {
      this.restoreEntrySnapshot(entry, previous);
      this.feedbackMessage = `${entry.displayName} CLI 전환 실패, 이전 상태로 복원됨`;
    }).finally(() => {
      this.state = { kind: "browse" };
      this.options.requestRender();
    });
  }

  private startBatchCliFromEdit(): void {
    const choices = this.getBatchCliChoices();
    if (choices.length === 0) return;
    this.state = {
      choices,
      cursor: this.getPreferredBatchChoiceIndex(choices),
      kind: "batchFrom",
    };
    this.feedbackMessage = null;
    this.options.requestRender();
  }

  private confirmBatchCliFromEdit(): void {
    if (this.state.kind !== "batchFrom") return;
    const selected = this.state.choices[this.state.cursor];
    if (!selected) return;
    if (selected.carrierCount === 0) {
      this.feedbackMessage = `${this.getCliDisplayName(selected.cliType)} 캐리어가 없어 일괄 전환을 시작할 수 없습니다.`;
      this.options.requestRender();
      return;
    }
    const nextChoices = this.getBatchCliChoices(selected.cliType);
    this.state = {
      choices: nextChoices,
      cursor: Math.max(0, nextChoices.findIndex((choice) => choice.carrierCount > 0)),
      fromCli: selected.cliType,
      kind: "batchTo",
    };
    this.feedbackMessage = null;
    this.options.requestRender();
  }

  private confirmBatchCliToEdit(): void {
    if (this.state.kind !== "batchTo") return;
    const fromCli = this.state.fromCli;
    const selected = this.state.choices[this.state.cursor];
    if (!selected) return;
    const entries = this.getEntries().filter((entry) => entry.cliType === fromCli);
    const previousByCarrierId = new Map<string, EntrySnapshot>();
    for (const entry of entries) {
      previousByCarrierId.set(entry.carrierId, this.captureEntrySnapshot(entry));
      this.applyResolvedSelection(entry, selected.cliType, this.getDefaultResolvedCliSelection(selected.cliType));
    }
    const updates = entries.map((entry) => ({ carrierId: entry.carrierId, newCliType: selected.cliType }));
    this.state = { kind: "saving" };
    this.feedbackMessage = entries.length > 0
      ? `${entries.map((entry) => entry.displayName).join(", ")} → ${this.getCliDisplayName(selected.cliType)} 전환 중...`
      : `${this.getCliDisplayName(fromCli)} 캐리어가 없어 변경되지 않았습니다.`;
    this.options.requestRender();
    void this.createStatusOverlayController().changeCliTypes(updates).then((results) => {
      this.finishMultiCliChange(results, previousByCarrierId, `→ ${this.getCliDisplayName(selected.cliType)} 전환 완료`);
    }).catch(() => {
      this.restoreSnapshots(previousByCarrierId);
      this.feedbackMessage = "저장 실패: 예상치 못한 오류가 발생했습니다.";
    }).finally(() => {
      this.state = { kind: "browse" };
      this.options.requestRender();
    });
  }

  private resetCliTypesToDefault(): void {
    const previousByCarrierId = new Map(this.getEntries().map((entry) => [entry.carrierId, this.captureEntrySnapshot(entry)]));
    this.state = { kind: "saving" };
    this.feedbackMessage = "기본 CLI 복원 중...";
    this.options.requestRender();
    void this.createStatusOverlayController().resetCliTypesToDefault().then((results) => {
      this.finishMultiCliChange(results, previousByCarrierId, "기본 CLI 복원 완료");
    }).catch(() => {
      this.restoreSnapshots(previousByCarrierId);
      this.feedbackMessage = "저장 실패: 예상치 못한 오류가 발생했습니다.";
    }).finally(() => {
      this.state = { kind: "browse" };
      this.options.requestRender();
    });
  }

  private finishMultiCliChange(
    results: readonly CliTypeChangeSettledResult[],
    previousByCarrierId: Map<string, EntrySnapshot>,
    successMessage: string,
  ): void {
    const succeeded: string[] = [];
    const failed: string[] = [];
    for (const outcome of results) {
      const entry = this.getEntryById(outcome.carrierId);
      if (outcome.status === "fulfilled" && outcome.result) {
        if (entry) this.applyResolvedSelection(entry, outcome.result.newCliType, outcome.result.selection);
        succeeded.push(outcome.carrierId);
      } else {
        if (entry) {
          const previous = previousByCarrierId.get(outcome.carrierId);
          if (previous) this.restoreEntrySnapshot(entry, previous);
        }
        failed.push(outcome.carrierId);
      }
    }
    if (failed.length === 0) {
      this.feedbackMessage = `${successMessage} (${succeeded.length}개)`;
    } else if (succeeded.length === 0) {
      this.feedbackMessage = `전체 전환 실패: ${failed.join(", ")}`;
    } else {
      this.feedbackMessage = `부분 전환 성공 (${succeeded.length}개) / 실패 (${failed.length}개): ${failed.join(", ")}`;
    }
  }

  private startRenameEdit(): void {
    const entry = this.getSelectedEntry();
    if (!entry) return;
    this.renameState = {
      carrierId: entry.carrierId,
      draft: entry.displayName,
    };
    this.feedbackMessage = null;
    this.options.requestRender();
  }

  private handleRenameInput(data: string): void {
    if (!this.renameState) return;
    if (matchesKey(data, "escape")) {
      this.cancelEdit();
      return;
    }
    if (matchesKey(data, "enter")) {
      this.confirmRenameEdit();
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.renameState = {
        ...this.renameState,
        draft: this.renameState.draft.slice(0, -1),
      };
      this.feedbackMessage = null;
      this.options.requestRender();
      return;
    }
    if (!isPrintable(data)) return;
    const nextDraft = normalizeCarrierDisplayNameInput(this.renameState.draft + data);
    if (nextDraft == null) return;
    this.renameState = {
      ...this.renameState,
      draft: nextDraft,
    };
    this.feedbackMessage = null;
    this.options.requestRender();
  }

  private confirmRenameEdit(): void {
    if (!this.renameState) return;
    const entry = this.getEntryById(this.renameState.carrierId);
    if (!entry) return;
    const previousDisplayName = entry.displayName;
    const draft = this.renameState.draft;
    const registry = this.options.carrierRuntime.registry;
    const sourceDisplayName = getCarrierSourceDisplayName(registry, entry.carrierId);
    const sanitizedDraft = sanitizeCarrierDisplayName(draft);
    const sanitizedSource = sanitizeCarrierDisplayName(sourceDisplayName);
    const reset = sanitizedDraft == null || sanitizedDraft === sanitizedSource;
    this.renameState = null;
    this.state = { kind: "saving" };
    this.feedbackMessage = reset ? `${previousDisplayName} 이름을 기본값으로 복원 중...` : `${previousDisplayName} 이름을 저장 중...`;
    this.options.requestRender();
    try {
      updateCarrierDisplayName(entry.carrierId, draft, sourceDisplayName);
      notifyStatusUpdate(registry);
      const nextDisplayName = resolveCarrierDisplayName(registry, entry.carrierId);
      entry.displayName = nextDisplayName;
      this.feedbackMessage = reset
        ? `${previousDisplayName} 이름을 기본값으로 복원했습니다. (${nextDisplayName})`
        : `${previousDisplayName} 이름을 저장했습니다. (${nextDisplayName})`;
    } catch (error) {
      this.feedbackMessage = `저장 실패: ${errorMessage(error)}`;
    } finally {
      this.state = { kind: "browse" };
      this.options.requestRender();
    }
  }

  private openTaskForce(): void {
    const entry = this.getSelectedEntry();
    if (!entry?.taskForceCapable) return;
    this.options.openTaskForcePanel({
      carrierDisplayName: entry.displayName,
      carrierId: entry.carrierId,
    });
  }

  private cancelEdit(): void {
    this.renameState = null;
    this.state = { kind: "browse" };
    this.feedbackMessage = null;
    this.options.requestRender();
  }

  private applyResolvedSelection(entry: CarrierStatusEntry, cliType: CarrierCliType, resolved: ResolvedCliSelection): void {
    entry.cliType = cliType;
    entry.model = resolved.model;
    entry.effort = resolved.effort;
    entry.isDefault = resolved.isDefault;
  }

  private getDefaultResolvedCliSelection(cliType: CarrierCliType): ResolvedCliSelection {
    const provider = this.getAvailableModels(cliType);
    const model = provider.defaultModel;
    return {
      effort: this.getDefaultEffort(cliType, model),
      isDefault: true,
      model,
    };
  }

  private captureEntrySnapshot(entry: CarrierStatusEntry): EntrySnapshot {
    return {
      cliType: entry.cliType,
      effort: entry.effort,
      isDefault: entry.isDefault,
      model: entry.model,
    };
  }

  private restoreEntrySnapshot(entry: CarrierStatusEntry, snapshot: EntrySnapshot): void {
    entry.cliType = snapshot.cliType;
    entry.model = snapshot.model;
    entry.effort = snapshot.effort;
    entry.isDefault = snapshot.isDefault;
  }

  private restoreSnapshots(previousByCarrierId: Map<string, EntrySnapshot>): void {
    for (const entry of this.getEntries()) {
      const previous = previousByCarrierId.get(entry.carrierId);
      if (previous) this.restoreEntrySnapshot(entry, previous);
    }
  }

  private getEntryById(carrierId: string): CarrierStatusEntry | null {
    return this.getEntries().find((entry) => entry.carrierId === carrierId) ?? null;
  }

  private getBatchCliChoices(excludeCli?: CarrierCliType): BatchCliChoice[] {
    return this.getAllCliTypes()
      .filter((cliType) => cliType !== excludeCli)
      .map((cliType) => ({
        carrierCount: this.getEntries().filter((entry) => entry.cliType === cliType).length,
        cliType,
        label: `${this.getCliDisplayName(cliType)} (${this.getEntries().filter((entry) => entry.cliType === cliType).length} carriers)`,
      }));
  }

  private getPreferredBatchChoiceIndex(choices: readonly BatchCliChoice[]): number {
    return Math.max(0, choices.findIndex((choice) => choice.carrierCount > 0));
  }

  private createStatusOverlayController(): InstanceType<typeof StatusOverlayController> {
    return new StatusOverlayController({
      applyAgentCliTypeSelectionUpdate: async (
        carrierId,
        newCliType,
        defaultCliType,
        previousCliType,
        previousSelection,
        selection,
      ) => {
        await applyAgentCliTypeSelectionUpdate(
          carrierId,
          newCliType,
          defaultCliType,
          previousCliType,
          previousSelection,
          selection,
        );
      },
      getAvailableModels: (cliType) => this.getAvailableModels(cliType),
      getCurrentModelSelection: (carrierId) => {
        const entry = this.getEntryById(carrierId);
        return entry ? { model: entry.model, effort: entry.effort ?? undefined } : undefined;
      },
      getEffort: (cliType, modelId) => this.getModelEffort(cliType, modelId),
      getEntries: () => this.getEntries(),
      getAgentCliSelection: (carrierId, cliType) => getAgentCliSelection(carrierId, cliType),
      getCarrierConfig: (carrierId) => getCarrierConfig(this.options.carrierRuntime.registry, carrierId),
      getRegisteredOrder: () => getRegisteredOrder(this.options.carrierRuntime.registry),
      getResolvedCliType: (carrierId) => {
        const config = getCarrierConfig(this.options.carrierRuntime.registry, carrierId);
        return config ? resolveAgentCliType(carrierId, config.defaultCliType) : undefined;
      },
      notifyStatusUpdate: () => notifyStatusUpdate(this.options.carrierRuntime.registry),
      refreshAgentPanel: () => undefined,
      saveAgentCliSelection: (carrierId, cliType, selection) => {
        saveAgentCliSelection(carrierId, cliType, selection);
      },
      syncModelConfig: () => undefined,
      updateCarrierCliType: (carrierId, cliType) => {
        updateCarrierCliType(this.options.carrierRuntime.registry, carrierId, cliType);
      },
    });
  }

  private getAvailableModels(cliType: CarrierCliType): CliModelInfo {
    return getAvailableModels(cliType);
  }

  private getModelEffort(cliType: CarrierCliType, modelId: string): ModelEffort {
    return getModelEffort(cliType, modelId);
  }

  private getModelEffortLevels(cliType: CarrierCliType, modelId: string): string[] {
    const effort = this.getModelEffort(cliType, modelId);
    return effort.supported ? [...(effort.levels ?? [])] : [];
  }

  private getDefaultEffort(cliType: CarrierCliType, modelId: string): string | null {
    const effort = this.getModelEffort(cliType, modelId);
    if (!effort.supported) return null;
    return effort.default ?? effort.levels?.[0] ?? null;
  }

  private getAllCliTypes(): CarrierCliType[] {
    return [...TASKFORCE_CLI_TYPES] as CarrierCliType[];
  }

  private getCliDisplayName(cliType: string): string {
    return CLI_DISPLAY_NAMES[cliType] ?? cliType;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
