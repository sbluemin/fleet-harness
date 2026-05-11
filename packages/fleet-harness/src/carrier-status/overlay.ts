/**
 * status-overlay.ts — 캐리어 함대 현황 오버레이 컴포넌트
 *
 * Alt+O로 호출되며, 등록된 모든 캐리어의 모델·추론 설정을 표시/편집합니다.
 * Component + Focusable 인터페이스를 구현하여 ctx.ui.custom() editor-replace로 렌더링합니다.
 *
 * 그룹 헤더 우측에 service-status 결과를 표시합니다.
 * 매 render() 호출마다 최신 service snapshot을 반영합니다.
 */

import type { ExtensionAPI } from "@sbluemin/fleet-coding-agent";
import type { Component, Focusable, TUI } from "@sbluemin/fleet-tui";
import { Key, matchesKey, visibleWidth } from "@sbluemin/fleet-tui";
import type { Theme } from "@sbluemin/fleet-coding-agent";

import { CLI_BACKENDS, type HealthStatus } from "@sbluemin/fleet-unified-agent";
import {
  getEffort,
  getProviderModels,
  getServiceSnapshots,
  refreshStatusQuiet,
} from "@sbluemin/fleet-unified-agent";
import type { CliType, ProviderModelInfo } from "@sbluemin/fleet-unified-agent";
import { admiral, type CarrierCategory, type TaskForceCliType } from "@sbluemin/fleet-core";
import { CARRIER_BG_COLORS, CARRIER_COLORS, CLI_DISPLAY_NAMES } from "../fleet-core-facades.js";
import {
  getConfiguredTaskForceBackends,
  getConfiguredTaskForceCarrierIds,
  getPerCliSettings,
  getTaskForceModelConfig,
  loadModels as getModelConfig,
  resetTaskForceModelSelection,
  savePerCliSettings,
  saveOfflineCarriers,
  saveSquadronEnabled,
  updateCliTypeOverride,
  updateModelSelection,
  updateTaskForceModelSelection,
  StatusOverlayController,
  TASKFORCE_CLI_TYPES,
} from "../fleet-core-facades.js";

import { getKeybindAPI } from "../keybinds.js";
import { refreshAgentPanel } from "../panel/ui.js";
import { syncModelConfig } from "../panel/config.js";
import {
  setCarrierOffline,
  disableSquadronCarrier,
  setCarrierOnline,
  enableSquadronCarrier,
  getRegisteredCarrierConfig,
  getRegisteredOrder,
  getOfflineCarrierIds,
  getSquadronEnabledIds,
  isCarrierOnline,
  isSquadronCarrierEnabled,
  notifyStatusUpdate,
  resolveCarrierDisplayName,
  setTaskForceConfiguredCarriers,
  updateCarrierCliType,
} from "../tools.js";
import { createOverlayFrame, resolveEditorCardWidth } from "./frame.js";
import { buildModelEffortTransition } from "./model-flow.js";
import { TaskForceConfigOverlay } from "./taskforce-overlay.js";
import type {
  BatchCliChoice,
  CarrierCliType,
  CarrierOverlayCallbacks,
  CarrierStatusEntry,
  CliModelInfo,
  CliTypeChoice,
  ModelSelection,
  ModelSelection as OverlayModelSelection,
  OverlayState,
  ResolvedCliSelection,
} from "./types.js";

interface CarrierStatusOverlayCallbacks extends CarrierOverlayCallbacks {
  saveDisplayName?: (carrierId: string, displayName: string) => Promise<string>;
}

interface EntrySnapshot {
  cliType: CarrierCliType;
  effort: string | null;
  isDefault: boolean;
  model: string;
}

interface GroupedEntries {
  category: CarrierCategory | "uncategorized";
  color: string;
  entries: CarrierStatusEntry[];
  header: string;
}

interface StatusOverlayViewModel {
  flatEntries: CarrierStatusEntry[];
  groupedEntries: GroupedEntries[];
  selectedCarrierId: string | null;
  snapshots: Map<CarrierCliType, { status: HealthStatus }>;
}

const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[38;2;100;100;100m";
const SLOT_WIDTH = 4;
const NAME_WIDTH = 12;
const MIN_EDITOR_CARD_WIDTH = 40;
const ALL_CLI_TYPES = Object.keys(CLI_BACKENDS) as CarrierCliType[];

const STATUS_TEXT: Record<HealthStatus, string> = {
  operational: "OP",
  partial_outage: "DEG",
  major_outage: "OUT",
  maintenance: "MNT",
  unknown: "UNK",
};

const STATUS_COLORS: Record<HealthStatus, string> = {
  operational: "\x1b[38;2;80;200;120m",
  partial_outage: "\x1b[38;2;220;180;50m",
  major_outage: "\x1b[38;2;220;80;80m",
  maintenance: "\x1b[38;2;200;170;60m",
  unknown: "\x1b[38;2;120;120;120m",
};

export class CarrierStatusOverlay implements Component, Focusable {
  focused = false;

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly callbacks: CarrierStatusOverlayCallbacks;
  private readonly done: () => void;

  private expandedCarrierId: string | null = null;
  private feedbackMessage: string | null = null;
  private renameState: { carrierId: string; draft: string } | null = null;
  private selectedCarrierId: string | null;
  private state: OverlayState;

  constructor(
    tui: TUI,
    theme: Theme,
    entries: CarrierStatusEntry[],
    callbacks: CarrierStatusOverlayCallbacks,
    done: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.callbacks = callbacks;
    this.done = done;
    this.selectedCarrierId = entries[0]?.carrierId ?? null;
    this.state = { kind: "browse" };
  }

  handleInput(data: string): void {
    if (this.state.kind === "saving") {
      return;
    }

    if (this.renameState) {
      this.handleRenameInput(data);
      return;
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.alt("o"))) {
      if (this.state.kind === "browse") {
        this.done();
      } else {
        this.cancelEdit();
      }
      return;
    }

    if (matchesKey(data, Key.up)) {
      if (this.state.kind === "browse") {
        this.moveSelection(-1);
      } else {
        this.moveEditCursor(-1);
      }
      return;
    }

    if (matchesKey(data, Key.down)) {
      if (this.state.kind === "browse") {
        this.moveSelection(1);
      } else {
        this.moveEditCursor(1);
      }
      return;
    }

    if (this.state.kind === "browse" && matchesKey(data, Key.tab)) {
      this.toggleDetails();
      return;
    }

    if (this.state.kind === "browse" && data === "t") {
      this.handleTaskForce();
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

    if (this.state.kind === "browse" && data === "S") {
      this.toggleSquadronState();
      return;
    }

    if (matchesKey(data, Key.enter)) {
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
  }

  render(width: number): string[] {
    const frameWidth = resolveEditorCardWidth(width, MIN_EDITOR_CARD_WIDTH);

    const dim = (s: string) => this.theme.fg("dim", s);
    const viewModel = this.buildViewModel();
    const frame = createOverlayFrame(this.theme, frameWidth, " Carrier Status ", ANSI_RESET);
    const innerWidth = frame.innerWidth;

    const lines: string[] = [];
    lines.push(frame.topBorder);
    lines.push(frame.emptyRow());

    if (this.state.kind === "batchFrom" || this.state.kind === "batchTo") {
      for (const line of this.buildBatchCliPanelLines()) {
        lines.push(frame.row(line));
      }
      lines.push(frame.emptyRow());
      lines.push(frame.separator());
      lines.push(frame.emptyRow());
    }

    for (let gi = 0; gi < viewModel.groupedEntries.length; gi++) {
      const group = viewModel.groupedEntries[gi]!;
      lines.push(frame.row(`  ${group.color}◇${ANSI_RESET} ${group.color}${group.header}${ANSI_RESET}`));
      lines.push(frame.emptyRow());

      for (const entry of group.entries) {
        const isSelected = entry.carrierId === viewModel.selectedCarrierId;
        const slotStr = `#${entry.slot}`;
        const slotPad = " ".repeat(Math.max(0, SLOT_WIDTH - slotStr.length));
        const namePad = " ".repeat(Math.max(0, NAME_WIDTH - entry.displayName.length));
        const isDisabled = !entry.isSortieEnabled;
        const nameColor = isDisabled ? ANSI_DIM : this.getEntryColor(entry);
        const coloredName = `${nameColor}${entry.displayName}${ANSI_RESET}`;
        const modelName = this.callbacks.getAvailableModels(entry.cliType).models.find(m => m.modelId === entry.model)?.name ?? entry.model;
        const modelStr = (entry.isDefault || isDisabled) ? dim(modelName) : modelName;
        const effortSupported = getModelEffortLevels(entry.cliType, entry.model).length > 0;
        const effortStr = effortSupported && entry.effort ? dim(" · ") + (isDisabled ? dim(entry.effort) : entry.effort) : "";
        const sortieTag = entry.isSquadronEnabled
          ? `  \x1b[38;2;180;140;255m→SQ${ANSI_RESET}`
          : isDisabled ? `  \x1b[38;2;255;80;80m✕ sortie off${ANSI_RESET}` : "";
        const tfTag = entry.taskForceBackendCount >= 2
          ? `  \x1b[38;2;100;180;255m[TF:${entry.taskForceBackendCount}]${ANSI_RESET}`
          : "";
        const sqTag = entry.isSquadronEnabled ? `  \x1b[38;2;180;140;255m[SQ]${ANSI_RESET}` : "";
        const roleStr = entry.role ? dim(`  (${entry.role})`) : "";
        const selectedPrefix = isSelected
          ? `${isDisabled ? ANSI_DIM : this.getEntryColor(entry)}▸${ANSI_RESET}`
          : " ";

        const content =
          `  ${selectedPrefix} ${dim(slotStr)}${slotPad}${coloredName}${namePad}${modelStr}${effortStr}${roleStr}${sortieTag}${tfTag}${sqTag}`;
        lines.push(frame.row(content, isSelected ? CARRIER_BG_COLORS[entry.cliType] : undefined));

        if (isSelected && this.shouldRenderEntryEditor(entry.carrierId)) {
          for (const optionLine of this.buildEntryEditorLines(entry)) {
            lines.push(frame.row(optionLine));
          }
        }

        if (isSelected && this.renameState?.carrierId === entry.carrierId) {
          for (const renameLine of this.buildRenameEditorLines()) {
            lines.push(frame.row(renameLine));
          }
        }

        if (isSelected && this.expandedCarrierId === entry.carrierId) {
          const detailRows = this.buildDetailRows(entry, innerWidth);
          for (const detailRow of detailRows) {
            lines.push(frame.row(detailRow));
          }
        }
      }

      if (gi < viewModel.groupedEntries.length - 1) {
        lines.push(frame.emptyRow());
      }
    }

    lines.push(frame.emptyRow());

    if (this.feedbackMessage) {
      const feedbackColor = this.feedbackMessage.startsWith("저장 실패") ? "warning" : "accent";
      lines.push(frame.row(this.theme.fg(feedbackColor, this.feedbackMessage)));
      lines.push(frame.emptyRow());
    }

    lines.push(frame.separator());
    lines.push(frame.row(dim(this.getFooterHint())));
    lines.push(frame.bottomBorder);

    return lines;
  }

  invalidate(): void {
    // 매 render마다 최신 엔트리와 service snapshot을 직접 참조합니다.
  }

  dispose(): void {
    // 정리할 리소스 없음
  }

  private getEntries(): CarrierStatusEntry[] {
    return this.callbacks.getEntries();
  }

  private buildViewModel(): StatusOverlayViewModel {
    const groupedEntries = this.getGroupedEntries();
    const flatEntries = groupedEntries.flatMap((group) => group.entries);
    return {
      flatEntries,
      groupedEntries,
      selectedCarrierId: this.resolveSelectedCarrierId(flatEntries),
      snapshots: this.callbacks.getServiceSnapshots(),
    };
  }

  private getGroupedEntries(): GroupedEntries[] {
    const CATEGORY_ORDER: CarrierCategory[] = ["strategy", "planning", "operations"];
    const CATEGORY_LABELS: Record<CarrierCategory | "uncategorized", string> = {
      strategy: "Strategy",
      planning: "Planning",
      operations: "Operations",
      uncategorized: "Uncategorized",
    };
    const CATEGORY_COLORS: Record<CarrierCategory | "uncategorized", string> = {
      strategy: "\x1b[38;2;100;180;255m",
      planning: "\x1b[38;2;180;140;255m",
      operations: "\x1b[38;2;80;200;120m",
      uncategorized: ANSI_DIM,
    };

    const entries = this.getEntries();
    const bucket = new Map<CarrierCategory | "uncategorized", CarrierStatusEntry[]>();

    for (const entry of entries) {
      const key: CarrierCategory | "uncategorized" = entry.category ?? "uncategorized";
      let list = bucket.get(key);
      if (!list) {
        list = [];
        bucket.set(key, list);
      }
      list.push(entry);
    }

    // 각 카테고리 내에서 slot 순 정렬
    for (const list of bucket.values()) {
      list.sort((a, b) => a.slot - b.slot);
    }

    const result: GroupedEntries[] = [];
    for (const cat of CATEGORY_ORDER) {
      const group = bucket.get(cat);
      if (!group || group.length === 0) continue;
      result.push({
        category: cat,
        color: CATEGORY_COLORS[cat],
        entries: group,
        header: CATEGORY_LABELS[cat],
      });
    }

    const uncategorized = bucket.get("uncategorized");
    if (uncategorized && uncategorized.length > 0) {
      result.push({
        category: "uncategorized",
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
    if (!selectedCarrierId) return null;
    return flatEntries.find((entry) => entry.carrierId === selectedCarrierId) ?? null;
  }

  private resolveSelectedCarrierId(entries: CarrierStatusEntry[]): string | null {
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
    const total = flatEntries.length;
    this.selectedCarrierId = flatEntries[(currentIndex + delta + total) % total]!.carrierId;
    this.feedbackMessage = null;
  }

  private moveEditCursor(delta: number): void {
    switch (this.state.kind) {
      case "model": {
        const total = this.state.choices.length;
        if (total === 0) return;
        this.state = {
          ...this.state,
          cursor: (this.state.cursor + delta + total) % total,
        };
        break;
      }
      case "effort": {
        const total = this.state.choices.length;
        if (total === 0) return;
        this.state = {
          ...this.state,
          cursor: (this.state.cursor + delta + total) % total,
        };
        break;
      }
      case "cliType": {
        const total = this.state.choices.length;
        if (total === 0) return;
        this.state = {
          ...this.state,
          cursor: (this.state.cursor + delta + total) % total,
        };
        break;
      }
      case "batchFrom": {
        const total = this.state.choices.length;
        if (total === 0) return;
        this.state = {
          ...this.state,
          cursor: (this.state.cursor + delta + total) % total,
        };
        break;
      }
      case "batchTo": {
        const total = this.state.choices.length;
        if (total === 0) return;
        this.state = {
          ...this.state,
          cursor: (this.state.cursor + delta + total) % total,
        };
        break;
      }
      case "browse":
      case "saving":
        return;
    }
    this.feedbackMessage = null;
    this.tui.requestRender();
  }

  private toggleDetails(): void {
    const entry = this.getSelectedEntry();
    if (!entry) return;
    this.expandedCarrierId = this.expandedCarrierId === entry.carrierId ? null : entry.carrierId;
    this.feedbackMessage = null;
  }

  private startModelEdit(): void {
    const entry = this.getSelectedEntry();
    if (!entry) return;

    const choices = this.callbacks.getAvailableModels(entry.cliType).models.map((model) => model.modelId);
    if (choices.length === 0) {
      this.feedbackMessage = `${entry.displayName}: 선택 가능한 모델이 없습니다.`;
      return;
    }

    this.state = {
      kind: "model",
      carrierId: entry.carrierId,
      choices,
      cursor: Math.max(0, choices.findIndex((modelId) => modelId === entry.model)),
    };
    this.feedbackMessage = null;
  }

  private confirmModelEdit(): void {
    if (this.state.kind !== "model") return;
    const entry = this.getEntryById(this.state.carrierId);
    if (!entry) return;

    const selectedModel = this.state.choices[this.state.cursor];
    if (!selectedModel) return;

    const transition = buildModelEffortTransition({
      currentEffort: entry.effort,
      effortChoices: getModelEffortLevels(entry.cliType, selectedModel),
      fallbackEffort: this.getDefaultEffort(entry.cliType, selectedModel),
      selectedModel,
    });

    if (transition.kind === "commit") {
      void this.commitSelection(entry, transition.selection);
      return;
    }

    this.state = {
      kind: "effort",
      carrierId: entry.carrierId,
      pendingModel: transition.pendingModel,
      choices: transition.choices,
      cursor: transition.cursor,
    };
  }

  private confirmEffortEdit(): void {
    if (this.state.kind !== "effort") return;
    const entry = this.getEntryById(this.state.carrierId);
    if (!entry) return;

    const selectedEffort = this.state.choices[this.state.cursor];
    if (!selectedEffort) return;

    const selection: ModelSelection = {
      model: this.state.pendingModel,
      effort: selectedEffort,
    };

    void this.commitSelection(entry, selection);
  }

  private handleTaskForce(): void {
    const entry = this.getSelectedEntry();
    if (!entry) return;
    this.callbacks.openTaskForce(entry.carrierId);
  }

  private toggleSortieState(): void {
    const entry = this.getSelectedEntry();
    if (!entry) return;

    // squadron 활성 캐리어는 sortie에서 자동 제외됨 — 사용자에게 안내
    if (entry.isSquadronEnabled) {
      this.feedbackMessage = `${entry.displayName}은(는) Squadron 모드 활성 중이므로 sortie에서 자동 제외됩니다. S키로 Squadron을 먼저 비활성화하세요.`;
      this.tui.requestRender();
      return;
    }

    this.callbacks.toggleSortieEnabled(entry.carrierId);
    entry.isSortieEnabled = !entry.isSortieEnabled;
    this.feedbackMessage = entry.isSortieEnabled
      ? `${entry.displayName} sortie 활성화됨`
      : `${entry.displayName} sortie 비활성화됨`;
    this.tui.requestRender();
  }

  private toggleSquadronState(): void {
    const entry = this.getSelectedEntry();
    if (!entry) return;

    this.callbacks.toggleSquadronEnabled(entry.carrierId);
    entry.isSquadronEnabled = !entry.isSquadronEnabled;
    this.feedbackMessage = entry.isSquadronEnabled
      ? `${entry.displayName} squadron 활성화됨`
      : `${entry.displayName} squadron 비활성화됨`;
    this.tui.requestRender();
  }

  private startCliTypeEdit(): void {
    const entry = this.getSelectedEntry();
    if (!entry) return;

    const choices = ALL_CLI_TYPES.map((cli): CliTypeChoice => ({
      value: cli,
      label: cli !== entry.defaultCliType ? `${cli} (default: ${entry.defaultCliType})` : cli,
    }));
    this.state = {
      kind: "cliType",
      carrierId: entry.carrierId,
      choices,
      cursor: Math.max(0, choices.findIndex((choice) => choice.value === entry.cliType)),
    };
    this.feedbackMessage = null;
  }

  private startRenameEdit(): void {
    const entry = this.getSelectedEntry();
    if (!entry) return;
    this.renameState = {
      carrierId: entry.carrierId,
      draft: entry.displayName,
    };
    this.feedbackMessage = null;
    this.tui.requestRender();
  }

  private confirmCliTypeEdit(): void {
    if (this.state.kind !== "cliType") return;
    const entry = this.getEntryById(this.state.carrierId);
    if (!entry) return;

    const selected = this.state.choices[this.state.cursor];
    if (!selected) return;

    if (selected.value !== entry.cliType) {
      const previous = this.captureEntrySnapshot(entry);
      const nextCliType = selected.value;
      this.applyResolvedSelection(entry, nextCliType, this.getDefaultResolvedCliSelection(nextCliType));
      this.state = { kind: "saving" };
      this.feedbackMessage = `${entry.displayName} → ${nextCliType} 전환 중...`;
      this.tui.requestRender();
      void this.callbacks.changeCliType(entry.carrierId, nextCliType).then((resolved) => {
        this.applyResolvedSelection(entry, nextCliType, resolved);
        this.feedbackMessage = `${entry.displayName} → ${nextCliType} 전환 완료`;
      }).catch(() => {
        this.restoreEntrySnapshot(entry, previous);
        this.feedbackMessage = `${entry.displayName} CLI 전환 실패, 이전 상태로 복원됨`;
      }).finally(() => {
        this.state = { kind: "browse" };
        this.tui.requestRender();
      });
      return;
    }

    this.state = { kind: "browse" };
    this.tui.requestRender();
  }

  private cancelEdit(): void {
    this.renameState = null;
    this.state = { kind: "browse" };
    this.feedbackMessage = null;
    this.tui.requestRender();
  }

  private getDefaultEffort(cliType: CarrierCliType, modelId: string): string | null {
    const reasoning = getModelEffort(cliType, modelId);
    if (!reasoning.supported) return null;
    return reasoning.default ?? reasoning.levels?.[0] ?? null;
  }

  private buildDetailRows(entry: CarrierStatusEntry, innerWidth: number): string[] {
    const provider = this.callbacks.getAvailableModels(entry.cliType);
    const modelLabel = provider.models.find((model) => model.modelId === entry.model)?.name ?? entry.model;
    const description = entry.roleDescription ?? "-";
    const labelWidth = 8;
    const valueWidth = Math.max(10, innerWidth - 10 - labelWidth);
    const lines: string[] = [];

    const detailLine = (label: string, value: string) => {
      const paddedLabel = label.padEnd(labelWidth, " ");
      lines.push(`      ${this.theme.fg("dim", paddedLabel)} ${value}`);
    };

    detailLine("model", `${modelLabel} [${entry.model}]`);
    detailLine("cli", `${this.getCliDisplayName(entry.cliType)} (${entry.cliType})`);
    detailLine("role", entry.role ?? "-");
    const wrappedDescription = this.wrapText(description, valueWidth);
    for (let i = 0; i < wrappedDescription.length; i++) {
      const label = i === 0 ? "desc" : "";
      detailLine(label, wrappedDescription[i]!);
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
        continue;
      }

      if (current) {
        lines.push(current);
        current = word;
        continue;
      }

      lines.push(word.slice(0, maxWidth));
    }

    if (current) lines.push(current);
    return lines;
  }

  private getFooterHint(): string {
    if (this.renameState) {
      return "이름 입력  Enter save  Esc cancel  Backspace delete  empty = reset";
    }
    return this.state.kind === "browse"
      ? "↑↓ select  Enter edit  N rename  c cli  C batch  R reset  t tf  S sq  d toggle  Tab  Esc"
      : this.state.kind === "saving"
        ? "저장 중..."
        : "↑↓ select  Enter confirm  Esc cancel";
  }

  private async commitSelection(entry: CarrierStatusEntry, selection: ModelSelection): Promise<void> {
    const previous = {
      effort: entry.effort,
      isDefault: entry.isDefault,
      model: entry.model,
    };

    this.state = { kind: "saving" };
    this.applyModelSelection(entry, selection);

    try {
      await this.callbacks.saveModelSelection(entry.carrierId, selection);
      this.feedbackMessage = `${entry.displayName} 모델 설정을 저장했습니다.`;
    } catch (error) {
      entry.model = previous.model;
      entry.isDefault = previous.isDefault;
      entry.effort = previous.effort;
      const message = error instanceof Error ? error.message : String(error);
      this.feedbackMessage = `저장 실패: ${message}`;
    } finally {
      this.state = { kind: "browse" };
      this.tui.requestRender();
    }
  }

  private applyModelSelection(entry: CarrierStatusEntry, selection: ModelSelection): void {
    entry.model = selection.model;
    entry.isDefault = false;
    entry.effort = selection.effort ?? null;
  }

  private startBatchCliFromEdit(): void {
    const choices = this.getBatchCliChoices();
    if (choices.length === 0) return;

    this.state = {
      kind: "batchFrom",
      choices,
      cursor: this.getPreferredBatchChoiceIndex(choices),
    };
    this.feedbackMessage = null;
  }

  private confirmBatchCliFromEdit(): void {
    if (this.state.kind !== "batchFrom") return;
    const selected = this.state.choices[this.state.cursor];
    if (!selected) return;
    if (selected.carrierCount === 0) {
      this.feedbackMessage = `${selected.cliType} 캐리어가 없어 일괄 전환을 시작할 수 없습니다.`;
      this.tui.requestRender();
      return;
    }

    const nextChoices = this.getBatchCliChoices(selected.cliType);
    this.state = {
      kind: "batchTo",
      fromCli: selected.cliType,
      choices: nextChoices,
      cursor: Math.max(0, nextChoices.findIndex((choice) => choice.carrierCount > 0)),
    };
    this.feedbackMessage = null;
  }

  private confirmBatchCliToEdit(): void {
    if (this.state.kind !== "batchTo") return;
    const fromCli = this.state.fromCli;
    const selected = this.state.choices[this.state.cursor];
    if (!selected) return;

    const changedNames: string[] = [];
    const previousByCarrierId = new Map<string, EntrySnapshot>();
    const updates: Array<{ carrierId: string; newCliType: CarrierCliType }> = [];

    for (const entry of this.getEntries()) {
      if (entry.cliType !== fromCli) continue;
      previousByCarrierId.set(entry.carrierId, this.captureEntrySnapshot(entry));
      updates.push({ carrierId: entry.carrierId, newCliType: selected.cliType });
      this.applyResolvedSelection(entry, selected.cliType, this.getDefaultResolvedCliSelection(selected.cliType));
      changedNames.push(entry.displayName);
    }

    this.state = { kind: "saving" };
    this.feedbackMessage = changedNames.length > 0
      ? `${changedNames.join(", ")} → ${selected.cliType} 전환 중...`
      : `${fromCli} 캐리어가 없어 변경되지 않았습니다.`;
    this.tui.requestRender();

    void this.callbacks.changeCliTypes(updates).then((results) => {
      const succeeded: string[] = [];
      const failed: string[] = [];

      for (const outcome of results) {
        if (outcome.status === "fulfilled" && outcome.result) {
          const entry = this.getEntryById(outcome.carrierId);
          if (entry) {
            this.applyResolvedSelection(entry, outcome.result.newCliType, outcome.result.selection);
          }
          succeeded.push(outcome.carrierId);
        } else {
          const entry = this.getEntryById(outcome.carrierId);
          const previous = previousByCarrierId.get(outcome.carrierId);
          if (entry && previous) {
            this.restoreEntrySnapshot(entry, previous);
          }
          failed.push(outcome.carrierId);
        }
      }

      if (failed.length === 0) {
        this.feedbackMessage = `${changedNames.join(", ")} → ${selected.cliType} 전환 완료`;
      } else if (succeeded.length === 0) {
        this.feedbackMessage = `전체 전환 실패: ${failed.join(", ")}`;
      } else {
        this.feedbackMessage = `부분 전환 성공 (${succeeded.length}개) / 실패 (${failed.length}개): ${failed.join(", ")}`;
      }
    }).catch(() => {
      for (const entry of this.getEntries()) {
        const previous = previousByCarrierId.get(entry.carrierId);
        if (!previous) continue;
        this.restoreEntrySnapshot(entry, previous);
      }
      this.feedbackMessage = "저장 실패: 예상치 못한 오류가 발생했습니다.";
    }).finally(() => {
      this.state = { kind: "browse" };
      this.tui.requestRender();
    });
  }

  private resetCliTypesToDefault(): void {
    const previousByCarrierId = new Map<string, EntrySnapshot>();
    for (const entry of this.getEntries()) {
      previousByCarrierId.set(entry.carrierId, this.captureEntrySnapshot(entry));
    }

    this.state = { kind: "saving" };
    this.feedbackMessage = "기본 CLI 복원 중...";
    this.tui.requestRender();

    void this.callbacks.resetCliTypesToDefault().then((results) => {
      const succeeded: string[] = [];
      const failed: string[] = [];

      for (const outcome of results) {
        if (outcome.status === "fulfilled" && outcome.result) {
          const entry = this.getEntryById(outcome.carrierId);
          if (entry) {
            this.applyResolvedSelection(entry, outcome.result.newCliType, outcome.result.selection);
          }
          succeeded.push(outcome.carrierId);
        } else {
          const entry = this.getEntryById(outcome.carrierId);
          const previous = previousByCarrierId.get(outcome.carrierId);
          if (entry && previous) {
            this.restoreEntrySnapshot(entry, previous);
          }
          failed.push(outcome.carrierId);
        }
      }

      if (failed.length === 0) {
        this.feedbackMessage = `전체 캐리어 기본 CLI 복원 완료 (${succeeded.length}개)`;
      } else if (succeeded.length === 0) {
        this.feedbackMessage = `전체 복원 실패: ${failed.join(", ")}`;
      } else {
        this.feedbackMessage = `부분 복원 성공 (${succeeded.length}개) / 실패 (${failed.length}개): ${failed.join(", ")}`;
      }
    }).catch(() => {
      for (const entry of this.getEntries()) {
        const previous = previousByCarrierId.get(entry.carrierId);
        if (!previous) continue;
        this.restoreEntrySnapshot(entry, previous);
      }
      this.feedbackMessage = "저장 실패: 예상치 못한 오류가 발생했습니다.";
    }).finally(() => {
      this.state = { kind: "browse" };
      this.tui.requestRender();
    });
  }

  private buildBatchCliPanelLines(): string[] {
    if (this.state.kind !== "batchFrom" && this.state.kind !== "batchTo") {
      return [];
    }
    const batchState = this.state;
    const lines = [
      this.theme.fg("accent", batchState.kind === "batchFrom" ? "  Batch CLI: FROM 선택" : "  Batch CLI: TO 선택"),
    ];

    if (batchState.kind === "batchTo") {
      const fromChoice = this.getBatchCliChoices().find((choice) => choice.cliType === batchState.fromCli) ?? null;
      if (fromChoice) {
        lines.push(`  FROM: ${fromChoice.cliType} (${fromChoice.carrierCount} carriers)`);
      }
    }

    for (let i = 0; i < batchState.choices.length; i++) {
      const choice = batchState.choices[i]!;
      const cursor = i === batchState.cursor ? "▸" : " ";
      const marker = batchState.kind === "batchFrom" ? "○" : "○";
      const dimChoice = choice.carrierCount === 0 && batchState.kind === "batchFrom";
      const statusText = `${STATUS_COLORS[choice.status]}${STATUS_TEXT[choice.status]}${ANSI_RESET}`;
      const content = `${cursor} ${marker} ${choice.label}  ${statusText}`;
      lines.push(dimChoice ? this.theme.fg("dim", `  ${content}`) : `  ${content}`);
    }

    return lines;
  }

  private getBatchCliChoices(excludeCli?: CarrierCliType): BatchCliChoice[] {
    const snapshots = this.callbacks.getServiceSnapshots();
    return ALL_CLI_TYPES
      .filter((cliType) => cliType !== excludeCli)
      .map((cliType) => ({
        cliType,
        label: `${cliType} (${this.getEntries().filter((entry) => entry.cliType === cliType).length} carriers)`,
        carrierCount: this.getEntries().filter((entry) => entry.cliType === cliType).length,
        status: snapshots.get(cliType)?.status ?? "unknown",
      }));
  }

  private getPreferredBatchChoiceIndex(choices: BatchCliChoice[]): number {
    const degradedIndex = choices.findIndex((choice) =>
      choice.carrierCount > 0 && (choice.status === "major_outage" || choice.status === "partial_outage"));
    if (degradedIndex !== -1) return degradedIndex;
    return Math.max(0, choices.findIndex((choice) => choice.carrierCount > 0));
  }

  private shouldRenderEntryEditor(carrierId: string): boolean {
    switch (this.state.kind) {
      case "model":
      case "effort":
      case "cliType":
        return this.state.carrierId === carrierId;
      case "browse":
      case "batchFrom":
      case "batchTo":
      case "saving":
        return false;
    }
  }

  private buildEntryEditorLines(entry: CarrierStatusEntry): string[] {
    const options = this.getEntryEditorOptions(entry);
    const currentValue = this.getEntryEditorCurrentValue(entry);
    const cursor = this.getStateCursor();

    return options.map((option, index) => {
      const cursorToken = index === cursor ? `${this.getEntryColor(entry)}▸${ANSI_RESET}` : " ";
      const marker = option.value === currentValue ? "●" : "○";
      return `      ${cursorToken} ${marker} ${option.label}`;
    });
  }

  private buildRenameEditorLines(): string[] {
    if (!this.renameState) return [];
    const draft = this.renameState.draft;
    const visibleDraft = draft.length > 0 ? draft : this.theme.fg("dim", "(empty resets default)");
    return [
      this.theme.fg("accent", "      이름 변경"),
      `      ▸ ${visibleDraft}`,
    ];
  }

  private getEntryEditorOptions(entry: CarrierStatusEntry): Array<{ value: string; label: string }> {
    switch (this.state.kind) {
      case "model":
        return this.state.choices.map((modelId) => {
          const model = this.callbacks.getAvailableModels(entry.cliType).models.find((item) => item.modelId === modelId);
          return {
            value: modelId,
            label: `${modelId} · ${model?.name ?? modelId}`,
          };
        });
      case "effort":
        return this.state.choices.map((level) => ({ value: level, label: level }));
      case "cliType":
        return this.state.choices.map((choice) => ({ value: choice.value, label: choice.label }));
      case "browse":
      case "batchFrom":
      case "batchTo":
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
      case "browse":
      case "batchFrom":
      case "batchTo":
      case "saving":
        return null;
    }
  }

  private getStateCursor(): number {
    switch (this.state.kind) {
      case "model":
      case "effort":
      case "cliType":
      case "batchFrom":
      case "batchTo":
        return this.state.cursor;
      case "browse":
      case "saving":
        return 0;
    }
  }

  private applyResolvedSelection(
    entry: CarrierStatusEntry,
    cliType: CarrierCliType,
    resolved: ResolvedCliSelection,
  ): void {
    entry.cliType = cliType;
    entry.model = resolved.model;
    entry.effort = resolved.effort;
    entry.isDefault = resolved.isDefault;
  }

  private getDefaultResolvedCliSelection(cliType: CarrierCliType): ResolvedCliSelection {
    const provider = this.callbacks.getAvailableModels(cliType);
    return {
      model: provider.defaultModel,
      effort: this.getDefaultEffort(cliType, provider.defaultModel),
      isDefault: true,
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

  private getEntryById(carrierId: string): CarrierStatusEntry | null {
    return this.getEntries().find((entry) => entry.carrierId === carrierId) ?? null;
  }

  private getEntryColor(entry: CarrierStatusEntry): string {
    return CARRIER_COLORS[entry.cliType] ?? "";
  }

  private getCliDisplayName(cliType: CarrierCliType): string {
    return CLI_DISPLAY_NAMES[cliType] ?? cliType;
  }

  private handleRenameInput(data: string): void {
    if (!this.renameState) return;

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.alt("o"))) {
      this.cancelEdit();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      this.confirmRenameEdit();
      return;
    }

    if (matchesKey(data, Key.backspace) || data === "\x7f") {
      this.renameState = {
        ...this.renameState,
        draft: this.renameState.draft.slice(0, -1),
      };
      this.feedbackMessage = null;
      this.tui.requestRender();
      return;
    }

    if (!isPrintableTextInput(data)) {
      return;
    }

    const nextDraft = admiral.store.normalizeCarrierDisplayNameInput(this.renameState.draft + data);
    if (nextDraft == null) {
      return;
    }

    this.renameState = {
      ...this.renameState,
      draft: nextDraft,
    };
    this.feedbackMessage = null;
    this.tui.requestRender();
  }

  private confirmRenameEdit(): void {
    if (!this.renameState) return;
    const entry = this.getEntryById(this.renameState.carrierId);
    if (!entry) return;

    const previousDisplayName = entry.displayName;
    const draft = this.renameState.draft;
    const sanitizedDraft = admiral.store.sanitizeCarrierDisplayName(draft);
    const sourceDisplayName = admiral.carrier.getCarrierSourceDisplayName(entry.carrierId);
    const isResetRequest = sanitizedDraft == null
      || sanitizedDraft === admiral.store.sanitizeCarrierDisplayName(sourceDisplayName);

    this.renameState = null;
    this.state = { kind: "saving" };
    this.feedbackMessage = isResetRequest
      ? `${previousDisplayName} 이름을 기본값으로 복원 중...`
      : `${previousDisplayName} 이름을 저장 중...`;
    this.tui.requestRender();

    const saveDisplayName = this.callbacks.saveDisplayName;
    if (!saveDisplayName) {
      this.state = { kind: "browse" };
      this.feedbackMessage = "저장 실패: displayName 저장 콜백이 등록되지 않았습니다.";
      this.tui.requestRender();
      return;
    }

    void saveDisplayName(entry.carrierId, draft).then((resolvedDisplayName) => {
      const nextDisplayName = resolvedDisplayName || resolveCarrierDisplayName(entry.carrierId);
      entry.displayName = nextDisplayName;
      this.feedbackMessage = isResetRequest
        ? `${previousDisplayName} 이름을 기본값으로 복원했습니다. (${nextDisplayName})`
        : `${previousDisplayName} 이름을 저장했습니다. (${nextDisplayName})`;
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.feedbackMessage = `저장 실패: ${message}`;
    }).finally(() => {
      this.state = { kind: "browse" };
      this.tui.requestRender();
    });
  }
}

let activeStatusPopup: Promise<void> | null = null;
let dismissStatusPopup: (() => void) | null = null;

export function registerCarrierStatusKeybind(_pi: ExtensionAPI): void {
  const keybind = getKeybindAPI();
  keybind.register({
    extension: "fleet",
    action: "carrier-status",
    defaultKey: "alt+o",
    description: "캐리어 함대 현황 오버레이",
    category: "Fleet Bridge",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;

      if (activeStatusPopup) {
        dismissStatusPopup?.();
        return;
      }

      const entries = buildStatusEntries();
      activeStatusPopup = ctx.ui.custom(
        (tui: any, theme: any, _keybindings: any, done: () => void) => {
          dismissStatusPopup = done;
          const overlayController = createStatusOverlayController(entries, () => refreshAgentPanel(ctx));

          return new CarrierStatusOverlay(
            tui,
            theme,
            entries,
            {
              getEntries: () => entries,
              changeCliType: (carrierId: string, newCliType: CarrierCliType) => {
                return overlayController.changeCliType(carrierId, newCliType);
              },
              changeCliTypes: async (updates: Array<{ carrierId: string; newCliType: CarrierCliType }>) => {
                return overlayController.changeCliTypes(updates);
              },
              resetCliTypesToDefault: async () => {
                return overlayController.resetCliTypesToDefault();
              },
              saveModelSelection: async (carrierId: string, selection: OverlayModelSelection) => {
                await updateModelSelection(carrierId, selection);
                handleModelUpdated();
              },
              toggleSortieEnabled,
              toggleSquadronEnabled: (carrierId: string) => {
                toggleSquadronEnabled(carrierId);
                refreshAgentPanel(ctx);
              },
              saveDisplayName: async (carrierId: string, displayName: string) => {
                const sourceDefaultDisplayName = admiral.carrier.getCarrierSourceDisplayName(carrierId);
                admiral.store.updateCarrierDisplayName(carrierId, displayName, sourceDefaultDisplayName);
                notifyStatusUpdate();
                refreshAgentPanel(ctx);
                return resolveCarrierDisplayName(carrierId);
              },
              getAvailableModels: getCliModelInfo,
              getServiceSnapshots: () =>
                new Map(
                  getServiceSnapshots().map((snapshot) => [
                    snapshot.provider as CarrierCliType,
                    { status: snapshot.status },
                  ]),
                ),
              getDefaultCliType: () => "claude",
              openTaskForce: (carrierId: string) => {
                openTaskForceOverlay(carrierId, ctx);
              },
            },
            done,
          );
        },
        {
          overlay: false,
        },
      );

      try {
        refreshStatusQuiet();
        await activeStatusPopup;
      } finally {
        activeStatusPopup = null;
        dismissStatusPopup = null;
      }
    },
  });
}

function buildStatusEntries(): CarrierStatusEntry[] {
  const modelConfig = getModelConfig();
  const entries: CarrierStatusEntry[] = [];

  for (const id of getRegisteredOrder()) {
    const config = getRegisteredCarrierConfig(id);
    if (!config) continue;

    const cliType = config.cliType;
    const selection = modelConfig[id];
    const provider = getProviderModels(cliType);
    const meta = config.carrierMetadata;

    entries.push({
      carrierId: id,
      slot: config.slot,
      cliType,
      defaultCliType: config.defaultCliType as CarrierCliType,
      displayName: resolveCarrierDisplayName(id),
      model: selection?.model || provider.defaultModel,
      isDefault: !selection?.model,
      effort: selection?.effort ?? null,
      role: meta?.title ?? null,
      roleDescription: meta ? `${meta.title} — ${meta.summary}` : null,
      isSortieEnabled: isCarrierOnline(id),
      isSquadronEnabled: isSquadronCarrierEnabled(id),
      taskForceBackendCount: getConfiguredTaskForceBackends(id).length,
      category: meta?.category,
    });
  }

  return entries;
}

function createStatusOverlayController(
  entries: CarrierStatusEntry[],
  refreshPanel: () => void,
): InstanceType<typeof StatusOverlayController> {
  return new StatusOverlayController({
    getEntries: () => entries,
    getRegisteredOrder,
    getRegisteredCarrierConfig: (carrierId: string) => getRegisteredCarrierConfig(carrierId),
    getCurrentModelSelection: (carrierId: string) => getModelConfig()[carrierId],
    getAvailableModels: getCliModelInfo,
    getPerCliSettings: (carrierId: string, cliType: CarrierCliType) => getPerCliSettings(carrierId, cliType),
    savePerCliSettings: (carrierId: string, cliType: CarrierCliType, selection: unknown) => {
      savePerCliSettings(carrierId, cliType, selection);
    },
    updateCarrierCliType: (carrierId: string, cliType: CarrierCliType) => {
      updateCarrierCliType(carrierId, cliType as CliType);
    },
    updateModelSelection: async (carrierId: string, selection: unknown) => {
      await updateModelSelection(carrierId, selection);
    },
    refreshAgentPanel: refreshPanel,
    syncModelConfig,
    notifyStatusUpdate,
    updateCliTypeOverride: (carrierId: string, cliType: CarrierCliType, defaultCliType: CarrierCliType) => {
      updateCliTypeOverride(carrierId, cliType, defaultCliType);
    },
  });
}

function getCliModelInfo(cliType: CarrierCliType): CliModelInfo {
  const provider = getProviderModels(cliType as CliType);
  const modelEffort = getModelEffort(cliType, provider.defaultModel);
  return {
    ...provider,
    effort: {
      supported: modelEffort.supported,
      ...(modelEffort.supported && {
        levels: [...(modelEffort.levels ?? [])],
        default: modelEffort.default,
      }),
    },
  } as CliModelInfo;
}

function getModelEffortLevels(cliType: CarrierCliType, modelId: string): string[] {
  const reasoning = getModelEffort(cliType, modelId);
  return reasoning.supported ? [...(reasoning.levels ?? [])] : [];
}

function getModelEffort(cliType: CarrierCliType, modelId: string): ReturnType<typeof getEffort> {
  return getEffort(cliType as CliType, modelId);
}

function handleModelUpdated(): void {
  syncModelConfig();
  notifyStatusUpdate();
}

function toggleSortieEnabled(carrierId: string): void {
  if (isCarrierOnline(carrierId)) {
    setCarrierOffline(carrierId);
  } else {
    setCarrierOnline(carrierId);
  }
  saveOfflineCarriers(getOfflineCarrierIds());
  notifyStatusUpdate();
}

function toggleSquadronEnabled(carrierId: string): void {
  if (isSquadronCarrierEnabled(carrierId)) {
    disableSquadronCarrier(carrierId);
  } else {
    enableSquadronCarrier(carrierId);
  }
  const registeredSet = new Set(getRegisteredOrder());
  saveSquadronEnabled(getSquadronEnabledIds().filter((id) => registeredSet.has(id)));
  notifyStatusUpdate();
}

function openTaskForceOverlay(carrierId: string, ctx: Parameters<Parameters<ReturnType<typeof getKeybindAPI>["register"]>[0]["handler"]>[0]): void {
  dismissStatusPopup?.();
  const carrierConfig = getRegisteredCarrierConfig(carrierId);
  if (!carrierConfig) {
    ctx.ui.notify(`등록되지 않은 carrier입니다: ${JSON.stringify(carrierId)}`, "error");
    return;
  }

  const effectiveCarrierDisplayName = resolveCarrierDisplayName(carrierId);
  const tfCallbacks = {
    getAvailableModels: (cliType: string) => getProviderModels(requireTaskForceCliType(cliType)),
    getEffort: (cliType: string, modelId: string) => getModelEffort(requireTaskForceCliType(cliType), modelId),
    getBackendConfig: (cliType: string) => {
      const resolvedCliType = requireTaskForceCliType(cliType);
      const tfConfig = getTaskForceModelConfig(carrierId, resolvedCliType);
      const modelConfigNow = getModelConfig();
      const isCustom = !!(modelConfigNow[carrierId]?.taskforce?.[resolvedCliType]);
      const provider = getProviderModels(resolvedCliType);
      return {
        model: tfConfig?.model ?? provider.defaultModel,
        effort: tfConfig?.effort ?? null,
        isCustom,
      };
    },
    updateBackendConfig: async (cliType: string, selection: { model: string; effort?: string }) => {
      updateTaskForceModelSelection(
        carrierId,
        requireTaskForceCliType(cliType),
        selection,
      );
      syncConfiguredTaskForceCarriers();
    },
    resetBackendConfig: (cliType: string) => {
      resetTaskForceModelSelection(carrierId, requireTaskForceCliType(cliType));
      syncConfiguredTaskForceCarriers();
    },
  };

  void ctx.ui.custom(
    (tui2: any, theme2: any, _kb2: any, done2: () => void) =>
      new TaskForceConfigOverlay(tui2, theme2, carrierId, effectiveCarrierDisplayName, tfCallbacks, done2),
    {
      overlay: false,
    },
  );
}

function requireTaskForceCliType(cliType: string): TaskForceCliType {
  const allowedTaskForceCliTypes = new Set<string>(TASKFORCE_CLI_TYPES);
  if (!allowedTaskForceCliTypes.has(cliType)) {
    throw new Error(`Unsupported Task Force backend: ${cliType}`);
  }
  return cliType as TaskForceCliType;
}

function syncConfiguredTaskForceCarriers(): void {
  const tfIds = getConfiguredTaskForceCarrierIds(getRegisteredOrder());
  setTaskForceConfiguredCarriers(tfIds);
  notifyStatusUpdate();
}

function isPrintableTextInput(value: string): boolean {
  return value.length > 0
    && !value.startsWith("\x1b")
    && !/[\u0000-\u001f\u007f]/.test(value);
}
