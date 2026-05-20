import { admiral, TASKFORCE_CLI_TYPES } from "@sbluemin/fleet-core";
import {
  createOverlayFrame,
  isPrintable,
  matchesKey,
  MIN_DEDICATED_ROWS,
  visibleWidth,
  type Component,
  type FleetPtyApi,
  type FleetPtyTheme,
  type Focusable,
} from "@sbluemin/fleet-tui/pty";

import { buildModelEffortTransition } from "./model-flow.js";
import { TaskForceConfigOverlay } from "./taskforce-overlay.js";
import type {
  BatchCliChoice,
  CarrierCliType,
  CarrierStatusEntry,
  CliModelInfo,
  CliTypeChangeSettledResult,
  CliTypeChoice,
  FleetStoreSnapshot,
  ModelEffort,
  ModelSelection,
  OverlayState,
  ResolvedCliSelection,
} from "./types.js";

export interface CarrierStatusOverlayOptions {
  readonly done: () => void;
  readonly fleetPty: FleetPtyApi;
  readonly requestRender: () => void;
  readonly theme: FleetPtyTheme;
}

interface EntrySnapshot {
  readonly cliType: CarrierCliType;
  readonly effort: string | null;
  readonly isDefault: boolean;
  readonly model: string;
}

interface GroupedEntries {
  readonly color: string;
  readonly entries: CarrierStatusEntry[];
  readonly header: string;
}

interface RenameState {
  readonly carrierId: string;
  readonly draft: string;
}

interface StatusOverlayViewModel {
  readonly flatEntries: CarrierStatusEntry[];
  readonly groupedEntries: GroupedEntries[];
  readonly selectedCarrierId: string | null;
}

const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[38;2;100;100;100m";
const SLOT_WIDTH = 4;
const NAME_WIDTH = 12;
const CARRIER_STATUS_FRAME_ROWS = 3;
const CARRIER_STATUS_EXTRA_BODY_ROWS = 6;
const CATEGORY_ORDER = ["strategy", "planning", "operations"] as const;
const CATEGORY_LABELS: Record<string, string> = {
  operations: "Operations",
  planning: "Planning",
  strategy: "Strategy",
  uncategorized: "Uncategorized",
};
const CATEGORY_COLORS: Record<string, string> = {
  operations: "\x1b[38;2;80;200;120m",
  planning: "\x1b[38;2;180;140;255m",
  strategy: "\x1b[38;2;100;180;255m",
  uncategorized: ANSI_DIM,
};
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
    if (this.state.kind === "saving") return;

    if (this.renameState) {
      this.handleRenameInput(data);
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "alt+o")) {
      if (this.state.kind === "browse") {
        this.options.done();
      } else {
        this.cancelEdit();
      }
      return;
    }

    if (matchesKey(data, "up")) {
      if (this.state.kind === "browse") this.moveSelection(-1);
      else this.moveEditCursor(-1);
      return;
    }

    if (matchesKey(data, "down")) {
      if (this.state.kind === "browse") this.moveSelection(1);
      else this.moveEditCursor(1);
      return;
    }

    if (this.state.kind === "browse" && data === "\t") {
      this.toggleDetails();
      return;
    }

    if (this.state.kind === "browse" && matchesKey(data, "t")) {
      this.openTaskForce();
      return;
    }

    if (this.state.kind === "browse" && data === "c") {
      this.startCliTypeEdit();
      return;
    }

    if (this.state.kind === "browse" && data === "N") {
      this.startRenameEdit();
      return;
    }

    if (this.state.kind === "browse" && data === "C") {
      this.startBatchCliFromEdit();
      return;
    }

    if (this.state.kind === "browse" && data === "R") {
      this.resetCliTypesToDefault();
      return;
    }

    if (this.state.kind === "browse" && data === "d") {
      this.toggleSortieState();
      return;
    }

    if (!matchesKey(data, "enter")) return;
    switch (this.state.kind) {
      case "browse":
        this.startModelEdit();
        return;
      case "model":
        this.confirmModelEdit();
        return;
      case "effort":
        this.confirmEffortEdit();
        return;
      case "cliType":
        this.confirmCliTypeEdit();
        return;
      case "batchFrom":
        this.confirmBatchCliFromEdit();
        return;
      case "batchTo":
        this.confirmBatchCliToEdit();
        return;
    }
  }

  invalidate(): void {}

  desiredHeight(maxRows: number): number | undefined {
    return clampOverlayRows(maxRows, this.estimateRows() + CARRIER_STATUS_EXTRA_BODY_ROWS + CARRIER_STATUS_FRAME_ROWS);
  }

  render(width: number): string[] {
    const viewModel = this.buildViewModel();
    const body: Array<string | { bg?: string; text: string }> = [];

    if (this.state.kind === "batchFrom" || this.state.kind === "batchTo") {
      body.push(...this.buildBatchCliPanelLines(), "");
    }

    for (let gi = 0; gi < viewModel.groupedEntries.length; gi++) {
      const group = viewModel.groupedEntries[gi]!;
      body.push(`  ${group.color}◇${ANSI_RESET} ${group.color}${group.header}${ANSI_RESET}`);

      for (const entry of group.entries) {
        const isSelected = entry.carrierId === viewModel.selectedCarrierId;
        body.push({
          bg: isSelected ? this.getEntryBgColor(entry.cliType) : undefined,
          text: this.renderEntryLine(entry, isSelected),
        });

        if (isSelected && this.shouldRenderEntryEditor(entry.carrierId)) {
          body.push(...this.buildEntryEditorLines(entry));
        }

        if (isSelected && this.renameState?.carrierId === entry.carrierId) {
          body.push(...this.buildRenameEditorLines());
        }

        if (isSelected && this.expandedCarrierId === entry.carrierId) {
          body.push(...this.buildDetailRows(entry, Math.max(20, width - 8)));
        }
      }

      if (gi < viewModel.groupedEntries.length - 1) {
        body.push("");
      }
    }

    body.push("");
    if (this.feedbackMessage) {
      const tone = this.feedbackMessage.startsWith("저장 실패") ? this.options.theme.warning : this.options.theme.accent;
      body.push(tone(this.feedbackMessage), "");
    }

    return createOverlayFrame({
      body,
      footer: this.getFooterHint(),
      theme: this.options.theme,
      title: "Carrier Status",
      width,
    });
  }

  private getEntries(): CarrierStatusEntry[] {
    const snapshot = admiral.store.readStatesSnapshot();
    return buildStatusEntriesFromSnapshot(snapshot);
  }

  private buildViewModel(): StatusOverlayViewModel {
    const groupedEntries = this.getGroupedEntries();
    const flatEntries = groupedEntries.flatMap((group) => group.entries);
    return {
      flatEntries,
      groupedEntries,
      selectedCarrierId: this.resolveSelectedCarrierId(flatEntries),
    };
  }

  private getGroupedEntries(): GroupedEntries[] {
    const bucket = new Map<string, CarrierStatusEntry[]>();
    for (const entry of this.getEntries()) {
      const key = entry.category ?? "uncategorized";
      const list = bucket.get(key) ?? [];
      list.push(entry);
      bucket.set(key, list);
    }

    for (const list of bucket.values()) {
      list.sort((a, b) => a.slot - b.slot);
    }

    const result: GroupedEntries[] = [];
    for (const category of CATEGORY_ORDER) {
      const entries = bucket.get(category);
      if (!entries?.length) continue;
      result.push({
        color: CATEGORY_COLORS[category],
        entries,
        header: CATEGORY_LABELS[category],
      });
    }

    const uncategorized = bucket.get("uncategorized");
    if (uncategorized?.length) {
      result.push({
        color: CATEGORY_COLORS.uncategorized,
        entries: uncategorized,
        header: CATEGORY_LABELS.uncategorized,
      });
    }

    return result;
  }

  private getFlatEntries(): CarrierStatusEntry[] {
    return this.getGroupedEntries().flatMap((group) => group.entries);
  }

  private getSelectedEntry(): CarrierStatusEntry | null {
    const flatEntries = this.getFlatEntries();
    const selectedCarrierId = this.resolveSelectedCarrierId(flatEntries);
    return selectedCarrierId ? flatEntries.find((entry) => entry.carrierId === selectedCarrierId) ?? null : null;
  }

  private resolveSelectedCarrierId(entries: readonly CarrierStatusEntry[]): string | null {
    if (entries.length === 0) {
      this.selectedCarrierId = null;
      return null;
    }
    if (this.selectedCarrierId && entries.some((entry) => entry.carrierId === this.selectedCarrierId)) {
      return this.selectedCarrierId;
    }
    this.selectedCarrierId = entries[0]!.carrierId;
    return this.selectedCarrierId;
  }

  private moveSelection(delta: number): void {
    const flatEntries = this.getFlatEntries();
    if (flatEntries.length === 0) return;
    const selectedCarrierId = this.resolveSelectedCarrierId(flatEntries);
    const currentIndex = Math.max(0, flatEntries.findIndex((entry) => entry.carrierId === selectedCarrierId));
    this.selectedCarrierId = flatEntries[(currentIndex + delta + flatEntries.length) % flatEntries.length]!.carrierId;
    this.feedbackMessage = null;
    this.options.requestRender();
  }

  private moveEditCursor(delta: number): void {
    const cursorState = this.state;
    if (!("choices" in cursorState)) return;
    const total = cursorState.choices.length;
    if (total === 0) return;
    this.state = {
      ...cursorState,
      cursor: (cursorState.cursor + delta + total) % total,
    };
    this.feedbackMessage = null;
    this.options.requestRender();
  }

  private toggleDetails(): void {
    const entry = this.getSelectedEntry();
    if (!entry) return;
    this.expandedCarrierId = this.expandedCarrierId === entry.carrierId ? null : entry.carrierId;
    this.feedbackMessage = null;
    this.options.requestRender();
  }

  private renderEntryLine(entry: CarrierStatusEntry, isSelected: boolean): string {
    const dim = this.options.theme.dim;
    const slotStr = `#${entry.slot}`;
    const slotPad = " ".repeat(Math.max(0, SLOT_WIDTH - slotStr.length));
    const namePad = " ".repeat(Math.max(0, NAME_WIDTH - visibleWidth(entry.displayName)));
    const disabled = !entry.isSortieEnabled;
    const nameColor = disabled ? ANSI_DIM : this.getEntryColor(entry.cliType);
    const selectedPrefix = isSelected ? `${nameColor}▸${ANSI_RESET}` : " ";
    const coloredName = `${nameColor}${entry.displayName}${ANSI_RESET}`;
    const modelLabel = getModelLabel(this.getAvailableModels(entry.cliType), entry.model);
    const modelStr = entry.isDefault || disabled ? dim(modelLabel) : modelLabel;
    const effortSupported = this.getModelEffortLevels(entry.cliType, entry.model).length > 0;
    const effortStr = effortSupported && entry.effort ? `${dim(" · ")}${disabled ? dim(entry.effort) : entry.effort}` : "";
    const roleStr = entry.role ? dim(`  (${entry.role})`) : "";
    const sortieTag = disabled ? `  \x1b[38;2;255;80;80m✕ sortie off${ANSI_RESET}` : "";
    const tfTag = entry.taskForceBackendCount >= 2
      ? `  \x1b[38;2;100;180;255m[TF:${entry.taskForceBackendCount}]${ANSI_RESET}`
      : "";
    return `  ${selectedPrefix} ${dim(slotStr)}${slotPad}${coloredName}${namePad}${modelStr}${effortStr}${roleStr}${sortieTag}${tfTag}`;
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
      await admiral.store.updateModelSelection(entry.carrierId, selection);
      admiral.carrier.notifyStatusUpdate();
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
    if (matchesKey(data, "escape") || matchesKey(data, "alt+o")) {
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
    const nextDraft = admiral.store.normalizeCarrierDisplayNameInput(this.renameState.draft + data);
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
    const sourceDisplayName = admiral.carrier.getCarrierSourceDisplayName(entry.carrierId);
    const sanitizedDraft = admiral.store.sanitizeCarrierDisplayName(draft);
    const sanitizedSource = admiral.store.sanitizeCarrierDisplayName(sourceDisplayName);
    const reset = sanitizedDraft == null || sanitizedDraft === sanitizedSource;
    this.renameState = null;
    this.state = { kind: "saving" };
    this.feedbackMessage = reset ? `${previousDisplayName} 이름을 기본값으로 복원 중...` : `${previousDisplayName} 이름을 저장 중...`;
    this.options.requestRender();
    try {
      admiral.store.updateCarrierDisplayName(entry.carrierId, draft, sourceDisplayName);
      admiral.carrier.notifyStatusUpdate();
      const nextDisplayName = admiral.carrier.resolveCarrierDisplayName(entry.carrierId);
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

  private toggleSortieState(): void {
    const entry = this.getSelectedEntry();
    if (!entry) return;
    if (admiral.carrier.isCarrierOnline(entry.carrierId)) {
      admiral.carrier.setCarrierOffline(entry.carrierId);
    } else {
      admiral.carrier.setCarrierOnline(entry.carrierId);
    }
    admiral.store.saveOfflineCarriers(admiral.carrier.getOfflineCarrierIds());
    admiral.carrier.notifyStatusUpdate();
    entry.isSortieEnabled = !entry.isSortieEnabled;
    this.feedbackMessage = entry.isSortieEnabled ? `${entry.displayName} sortie 활성화됨` : `${entry.displayName} sortie 비활성화됨`;
    this.options.requestRender();
  }

  private openTaskForce(): void {
    const entry = this.getSelectedEntry();
    if (!entry) return;
    this.options.done();
    void this.options.fleetPty.custom<void>((ui, theme, _keys, done) => new TaskForceConfigOverlay({
      carrierDisplayName: entry.displayName,
      carrierId: entry.carrierId,
      done,
      requestRender: () => ui.requestRender(),
      theme,
    }));
  }

  private cancelEdit(): void {
    this.renameState = null;
    this.state = { kind: "browse" };
    this.feedbackMessage = null;
    this.options.requestRender();
  }

  private buildBatchCliPanelLines(): string[] {
    if (this.state.kind !== "batchFrom" && this.state.kind !== "batchTo") return [];
    const state = this.state;
    const title = state.kind === "batchFrom" ? "  Batch CLI: FROM 선택" : "  Batch CLI: TO 선택";
    const lines = [this.options.theme.accent(title)];
    if (state.kind === "batchTo") {
      const fromChoice = this.getBatchCliChoices().find((choice) => choice.cliType === state.fromCli);
      if (fromChoice) lines.push(`  FROM: ${this.getCliDisplayName(fromChoice.cliType)} (${fromChoice.carrierCount} carriers)`);
    }
    for (let i = 0; i < state.choices.length; i++) {
      const choice = state.choices[i]!;
      const cursor = i === state.cursor ? "▸" : " ";
      const content = `  ${cursor} ○ ${choice.label}`;
      lines.push(choice.carrierCount === 0 && state.kind === "batchFrom" ? this.options.theme.dim(content) : content);
    }
    return lines;
  }

  private buildEntryEditorLines(entry: CarrierStatusEntry): string[] {
    const options = this.getEntryEditorOptions(entry);
    const currentValue = this.getEntryEditorCurrentValue(entry);
    const cursor = this.getStateCursor();
    return options.map((option, index) => {
      const cursorToken = index === cursor ? `${this.getEntryColor(entry.cliType)}▸${ANSI_RESET}` : " ";
      const marker = option.value === currentValue ? "●" : "○";
      return `      ${cursorToken} ${marker} ${option.label}`;
    });
  }

  private buildRenameEditorLines(): string[] {
    if (!this.renameState) return [];
    const draft = this.renameState.draft.length > 0 ? this.renameState.draft : this.options.theme.dim("(empty resets default)");
    return [
      this.options.theme.accent("      이름 변경"),
      `      ▸ ${draft}`,
    ];
  }

  private buildDetailRows(entry: CarrierStatusEntry, innerWidth: number): string[] {
    const provider = this.getAvailableModels(entry.cliType);
    const modelLabel = getModelLabel(provider, entry.model);
    const labelWidth = 8;
    const valueWidth = Math.max(10, innerWidth - 10 - labelWidth);
    const lines: string[] = [];
    const detailLine = (label: string, value: string) => {
      lines.push(`      ${this.options.theme.dim(label.padEnd(labelWidth, " "))} ${value}`);
    };
    detailLine("model", modelLabel);
    detailLine("cli", this.getCliDisplayName(entry.cliType));
    detailLine("role", entry.role ?? "-");
    const desc = this.wrapText(entry.roleDescription ?? "-", valueWidth);
    for (let i = 0; i < desc.length; i++) {
      detailLine(i === 0 ? "desc" : "", desc[i]!);
    }
    return lines;
  }

  private wrapText(text: string, maxWidth: number): string[] {
    if (!text.trim()) return ["-"];
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (visibleWidth(candidate) <= maxWidth) {
        current = candidate;
      } else if (current) {
        lines.push(current);
        current = word;
      } else {
        lines.push(word.slice(0, maxWidth));
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  private getEntryEditorOptions(entry: CarrierStatusEntry): Array<{ value: string; label: string }> {
    switch (this.state.kind) {
      case "model":
        return this.state.choices.map((modelId) => ({
          label: getModelLabel(this.getAvailableModels(entry.cliType), modelId),
          value: modelId,
        }));
      case "effort":
        return this.state.choices.map((level) => ({ label: level, value: level }));
      case "cliType":
        return this.state.choices.map((choice) => ({ label: choice.label, value: choice.value }));
      case "batchFrom":
      case "batchTo":
      case "browse":
      case "saving":
        return [];
    }
  }

  private getEntryEditorCurrentValue(entry: CarrierStatusEntry): string | null {
    switch (this.state.kind) {
      case "model":
        return entry.model;
      case "effort":
        return entry.effort ?? this.getDefaultEffort(entry.cliType, this.state.pendingModel);
      case "cliType":
        return entry.cliType;
      case "batchFrom":
      case "batchTo":
      case "browse":
      case "saving":
        return null;
    }
  }

  private getStateCursor(): number {
    return "cursor" in this.state ? this.state.cursor : 0;
  }

  private shouldRenderEntryEditor(carrierId: string): boolean {
    return (this.state.kind === "model" || this.state.kind === "effort" || this.state.kind === "cliType")
      && this.state.carrierId === carrierId;
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

  private createStatusOverlayController(): InstanceType<typeof admiral.carrier.StatusOverlayController> {
    return new admiral.carrier.StatusOverlayController({
      applyCliTypeModelSelectionUpdate: async (
        carrierId,
        newCliType,
        defaultCliType,
        previousCliType,
        previousSelection,
        selection,
      ) => {
        await admiral.store.applyCliTypeModelSelectionUpdate(
          carrierId,
          newCliType,
          defaultCliType,
          previousCliType,
          previousSelection,
          selection,
        );
      },
      getAvailableModels: (cliType) => this.getAvailableModels(cliType),
      getCurrentModelSelection: (carrierId) => admiral.store.loadModels()[carrierId],
      getEffort: (cliType, modelId) => this.getModelEffort(cliType, modelId),
      getEntries: () => this.getEntries(),
      getPerCliSettings: (carrierId, cliType) => admiral.store.getPerCliSettings(carrierId, cliType),
      getRegisteredCarrierConfig: (carrierId) => admiral.carrier.getRegisteredCarrierConfig(carrierId),
      getRegisteredOrder: () => admiral.carrier.getRegisteredOrder(),
      getResolvedCliType: (carrierId) => {
        const config = admiral.carrier.getRegisteredCarrierConfig(carrierId);
        return config ? admiral.carrier.resolveCarrierCliType(carrierId, config.defaultCliType) : undefined;
      },
      notifyStatusUpdate: () => admiral.carrier.notifyStatusUpdate(),
      refreshAgentPanel: () => undefined,
      savePerCliSettings: (carrierId, cliType, selection) => {
        admiral.store.savePerCliSettings(carrierId, cliType, selection);
      },
      syncModelConfig: () => undefined,
      updateCarrierCliType: (carrierId, cliType) => {
        admiral.carrier.updateCarrierCliType(carrierId, cliType);
      },
    });
  }

  private getAvailableModels(cliType: CarrierCliType): CliModelInfo {
    try {
      const models = admiral.agent.models.getCliModels(cliType).map((model) => ({
        modelId: model.id,
        name: model.name,
      }));
      const defaultModel = models[0]?.modelId ?? "default";
      return {
        defaultModel,
        effort: this.getModelEffort(cliType, defaultModel),
        models,
        name: this.getCliDisplayName(cliType),
      };
    } catch {
      return {
        defaultModel: "default",
        effort: { supported: false },
        models: [],
        name: this.getCliDisplayName(cliType),
      };
    }
  }

  private getModelEffort(cliType: CarrierCliType, modelId: string): ModelEffort {
    try {
      const levels = admiral.agent.models.getCliEffortLevels(cliType, modelId);
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

  private getEntryColor(cliType: CarrierCliType): string {
    return admiral.constants.CARRIER_COLORS[cliType] ?? "";
  }

  private getEntryBgColor(cliType: CarrierCliType): string | undefined {
    return admiral.constants.CARRIER_BG_COLORS[cliType];
  }

  private getCliDisplayName(cliType: string): string {
    return admiral.constants.CLI_DISPLAY_NAMES[cliType] ?? cliType;
  }

  private getFooterHint(): string {
    if (this.renameState) return "이름 입력  Enter save  Esc cancel  Backspace delete  empty = reset";
    if (this.state.kind === "saving") return "저장 중...";
    if (this.state.kind === "browse") return "↑↓ select  Enter edit  N rename  c cli  C batch  R reset  t tf  S sq  d toggle  Tab  Esc";
    return "↑↓ select  Enter confirm  Esc cancel";
  }

  private estimateRows(): number {
    let rows = 0;
    for (const group of this.getGroupedEntries()) {
      rows += 2 + group.entries.length;
    }
    if (this.state.kind === "batchFrom" || this.state.kind === "batchTo") rows += this.buildBatchCliPanelLines().length + 1;
    const selected = this.getSelectedEntry();
    if (selected && this.shouldRenderEntryEditor(selected.carrierId)) rows += this.getEntryEditorOptions(selected).length;
    if (this.renameState) rows += 2;
    if (selected && this.expandedCarrierId === selected.carrierId) rows += 4;
    return rows;
  }
}

function buildStatusEntriesFromSnapshot(snapshot: FleetStoreSnapshot): CarrierStatusEntry[] {
  const entries: CarrierStatusEntry[] = [];
  const registeredOrder = admiral.carrier.getRegisteredOrder();
  const cliTypesByCarrier = buildCliTypesByCarrierFromSnapshot(snapshot);
  admiral.store.loadModels(cliTypesByCarrier);
  const healedSnapshot = admiral.store.readStatesSnapshot();

  for (const id of registeredOrder) {
    const config = admiral.carrier.getRegisteredCarrierConfig(id);
    if (!config) continue;
    const cliType = cliTypeForCarrierFromSnapshot(healedSnapshot, id, config.defaultCliType as CarrierCliType);
    const selection = healedSnapshot.models[id];
    const provider = getProviderModelsEquivalent(cliType);
    const meta = config.carrierMetadata;
    entries.push({
      carrierId: id,
      category: meta?.category,
      cliType,
      defaultCliType: config.defaultCliType as CarrierCliType,
      displayName: admiral.carrier.resolveCarrierDisplayName(id),
      effort: selection?.effort ?? null,
      isDefault: !selection?.model,
      isSortieEnabled: admiral.carrier.isCarrierOnline(id),
      model: selection?.model || provider.defaultModel,
      role: meta?.title ?? null,
      roleDescription: meta ? `${meta.title} - ${meta.summary}` : null,
      slot: config.slot,
      taskForceBackendCount: admiral.store.getConfiguredTaskForceBackendsFromSnapshot(healedSnapshot, id).length,
    });
  }

  return entries;
}

function buildCliTypesByCarrierFromSnapshot(snapshot: FleetStoreSnapshot): Record<string, CarrierCliType> {
  return Object.fromEntries(
    admiral.carrier.getRegisteredOrder()
      .map((id): [string, CarrierCliType] | null => {
        const config = admiral.carrier.getRegisteredCarrierConfig(id);
        if (!config) return null;
        return [id, cliTypeForCarrierFromSnapshot(snapshot, id, config.defaultCliType as CarrierCliType)];
      })
      .filter((entry): entry is [string, CarrierCliType] => entry !== null),
  );
}

function cliTypeForCarrierFromSnapshot(
  snapshot: FleetStoreSnapshot,
  carrierId: string,
  defaultCliType: CarrierCliType,
): CarrierCliType {
  return (snapshot.cliTypeOverrides[carrierId] as CarrierCliType | undefined) ?? defaultCliType;
}

function getProviderModelsEquivalent(cliType: CarrierCliType): CliModelInfo {
  try {
    const models = admiral.agent.models.getCliModels(cliType).map((model) => ({
      modelId: model.id,
      name: model.name,
    }));
    const defaultModel = models[0]?.modelId ?? "default";
    const levels = admiral.agent.models.getCliEffortLevels(cliType, defaultModel);
    return {
      defaultModel,
      effort: levels?.length ? { default: levels[0], levels, supported: true } : { supported: false },
      models,
      name: admiral.constants.CLI_DISPLAY_NAMES[cliType] ?? cliType,
    };
  } catch {
    return {
      defaultModel: "default",
      effort: { supported: false },
      models: [],
      name: admiral.constants.CLI_DISPLAY_NAMES[cliType] ?? cliType,
    };
  }
}

function getModelLabel(provider: CliModelInfo, modelId: string): string {
  return provider.models.find((model) => model.modelId === modelId)?.name ?? modelId;
}

function clampOverlayRows(maxRows: number, cardRows: number): number {
  const maxFleetRows = Math.max(0, maxRows - MIN_DEDICATED_ROWS);
  return Math.min(maxFleetRows, Math.max(0, cardRows));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
