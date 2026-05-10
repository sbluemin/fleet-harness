/**
 * fleet/carrier/taskforce-config-overlay.ts — Task Force 백엔드별 모델 설정 오버레이
 *
 * 특정 캐리어의 Task Force 모델/effort 설정을 편집하는 인터랙티브 오버레이입니다.
 * Component + Focusable 인터페이스를 구현하여 ctx.ui.custom() editor-replace로 렌더링합니다.
 *
 * 내비게이션: ↑↓ 백엔드 선택, Enter 모델 편집, R 리셋, Esc 닫기
 */

import type { Component, Focusable, TUI } from "@sbluemin/fleet-tui";
import { Key, matchesKey } from "@sbluemin/fleet-tui";
import type { Theme } from "@sbluemin/fleet-coding-agent";
import { CARRIER_BG_COLORS, CARRIER_COLORS, CLI_DISPLAY_NAMES } from "../fleet-core-facades.js";
import type { ProviderModelInfo } from "@sbluemin/fleet-unified-agent";
import {
  TASKFORCE_CLI_TYPES,
} from "../fleet-core-facades.js";
import type { TaskForceCliType } from "@sbluemin/fleet-core";

import { createOverlayFrame } from "./frame.js";
import { buildModelEffortTransition } from "./model-flow.js";

// ─── 타입 ────────────────────────────────────────────────

/** 백엔드 한 줄 표시 데이터 */
interface BackendEntry {
  cliType: TaskForceCliType;
  displayName: string;
  color: string;
  model: string;
  effort: string | null;
  /** false = origin(기본값), true = 커스텀 설정 존재 */
  isCustom: boolean;
}

interface TaskForceOverlayProps {
  getAvailableModels: (cliType: string) => ProviderModelInfo;
  getEffort: (
    cliType: string,
    modelId: string,
  ) => { supported: boolean; levels?: readonly string[]; default?: string };
  /** 백엔드별 현재 설정 반환 (origin 포함) */
  getBackendConfig: (cliType: string) => { model: string; effort: string | null; isCustom: boolean };
  /** 백엔드 설정 저장 */
  updateBackendConfig: (
    cliType: string,
    selection: { model: string; effort?: string },
  ) => Promise<void>;
  /** 백엔드 설정 초기화 (origin으로) */
  resetBackendConfig: (cliType: string) => void;
}

type OverlayMode = "browse" | "model" | "effort" | "saving";

// ─── 상수 ────────────────────────────────────────────────

const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[38;2;120;120;120m";
const ANSI_ACCENT = "\x1b[38;2;100;180;255m";
const MIN_EDITOR_CARD_WIDTH = 40;

// ─── 컴포넌트 ────────────────────────────────────────────

export class TaskForceConfigOverlay implements Component, Focusable {
  focused = false;

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly carrierDisplayName: string;
  private readonly callbacks: TaskForceOverlayProps;
  private readonly done: () => void;

  private selectedIndex = 0;
  private mode: OverlayMode = "browse";
  private editCursor = 0;
  private pendingModelId: string | null = null;
  private feedbackMessage: string | null = null;

  constructor(
    tui: TUI,
    theme: Theme,
    _carrierId: string,
    carrierDisplayName: string,
    callbacks: TaskForceOverlayProps,
    done: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.carrierDisplayName = carrierDisplayName;
    this.callbacks = callbacks;
    this.done = done;
  }

  handleInput(data: string): void {
    if (this.mode === "saving") return;

    if (matchesKey(data, Key.escape)) {
      if (this.mode === "browse") {
        this.done();
      } else {
        this.cancelEdit();
      }
      return;
    }

    if (matchesKey(data, Key.up)) {
      if (this.mode === "browse") {
        this.moveSelection(-1);
      } else {
        this.moveEditCursor(-1);
      }
      return;
    }

    if (matchesKey(data, Key.down)) {
      if (this.mode === "browse") {
        this.moveSelection(1);
      } else {
        this.moveEditCursor(1);
      }
      return;
    }

    // R 키: 선택된 백엔드 설정 리셋 (browse 모드)
    if (this.mode === "browse" && data === "r") {
      this.resetSelectedBackend();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      if (this.mode === "browse") {
        this.startModelEdit();
      } else if (this.mode === "model") {
        this.confirmModelEdit();
      } else if (this.mode === "effort") {
        this.confirmEffortEdit();
      }
    }
  }

  render(width: number): string[] {
    const frameWidth = resolveEditorCardWidth(width, MIN_EDITOR_CARD_WIDTH);

    const dim = (s: string) => this.theme.fg("dim", s);
    const frame = createOverlayFrame(this.theme, frameWidth, ` Task Force Config — ${this.carrierDisplayName} `, ANSI_RESET);

    const lines: string[] = [];
    lines.push(frame.topBorder);
    lines.push(frame.emptyRow());

    // ── 백엔드 행 ──
    const entries = this.buildBackendEntries();

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const isSelected = i === this.selectedIndex;

      const selectedPrefix = isSelected
        ? `${entry.color}▸${ANSI_RESET}`
        : " ";

      const modelStr = entry.isCustom ? entry.model : dim(entry.model);
      const effortSupported = this.getEffortLevels(entry.cliType, entry.model).length > 0;
      const effortStr = effortSupported && entry.effort
        ? ` ${dim("·")} ${entry.isCustom ? entry.effort : dim(entry.effort)}`
        : "";
      const configTag = entry.isCustom
        ? `  ${ANSI_ACCENT}(custom)${ANSI_RESET}`
        : `  ${ANSI_DIM}(origin)${ANSI_RESET}`;

      const content = `  ${selectedPrefix} ${entry.color}${entry.displayName}${ANSI_RESET}  ${modelStr}${effortStr}${configTag}`;
      lines.push(frame.row(content, isSelected ? CARRIER_BG_COLORS[entry.cliType] : undefined));

      // 모델 드롭다운 (선택된 행, model 편집 모드)
      if (isSelected && this.mode === "model") {
        const models = this.callbacks.getAvailableModels(entry.cliType).models;
        for (let j = 0; j < models.length; j++) {
          const model = models[j]!;
          const cursor = j === this.editCursor ? `${entry.color}▸${ANSI_RESET}` : " ";
          const marker = model.modelId === entry.model ? "●" : "○";
          lines.push(frame.row(`      ${cursor} ${marker} ${model.modelId}  ${dim(model.name)}`));
        }
      }

      // effort 드롭다운 (선택된 행, effort 편집 모드)
      if (isSelected && this.mode === "effort") {
        const effortLevels = this.getEffortLevels(entry.cliType, this.pendingModelId ?? entry.model);
        for (let j = 0; j < effortLevels.length; j++) {
          const level = effortLevels[j]!;
          const cursor = j === this.editCursor ? `${entry.color}▸${ANSI_RESET}` : " ";
          const marker = level === (entry.effort ?? "") ? "●" : "○";
          lines.push(frame.row(`      ${cursor} ${marker} ${level}`));
        }
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
    // render마다 최신 데이터를 직접 조회하므로 별도 캐시 없음
  }

  dispose(): void {
    // 정리할 리소스 없음
  }

  // ─── 내부 헬퍼 ──────────────────────────────────────────

  private buildBackendEntries(): BackendEntry[] {
    return TASKFORCE_CLI_TYPES.map((cliType) => {
      const config = this.callbacks.getBackendConfig(cliType);
      return {
        cliType,
        displayName: CLI_DISPLAY_NAMES[cliType] ?? cliType,
        color: CARRIER_COLORS[cliType] ?? "",
        model: config.model,
        effort: config.effort,
        isCustom: config.isCustom,
      };
    });
  }

  private getSelectedEntry(): BackendEntry | null {
    const entries = this.buildBackendEntries();
    return entries[this.selectedIndex] ?? null;
  }

  private moveSelection(delta: number): void {
    const total = TASKFORCE_CLI_TYPES.length;
    this.selectedIndex = (this.selectedIndex + delta + total) % total;
    this.feedbackMessage = null;
  }

  private moveEditCursor(delta: number): void {
    const entry = this.getSelectedEntry();
    if (!entry) return;
    const options = this.getEditOptions(entry);
    if (options.length === 0) return;
    this.editCursor = (this.editCursor + delta + options.length) % options.length;
    this.feedbackMessage = null;
  }

  private getEditOptions(entry: BackendEntry): Array<{ value: string }> {
    if (this.mode === "model") {
      return this.callbacks.getAvailableModels(entry.cliType).models.map((m) => ({ value: m.modelId }));
    }
    if (this.mode === "effort") {
      return this.getEffortLevels(entry.cliType, this.pendingModelId ?? entry.model).map((level) => ({ value: level }));
    }
    return [];
  }

  private startModelEdit(): void {
    const entry = this.getSelectedEntry();
    if (!entry) return;

    const models = this.callbacks.getAvailableModels(entry.cliType).models;
    if (models.length === 0) {
      this.feedbackMessage = `${entry.displayName}: 선택 가능한 모델이 없습니다.`;
      return;
    }

    this.mode = "model";
    this.pendingModelId = null;
    this.editCursor = Math.max(0, models.findIndex((m) => m.modelId === entry.model));
    this.feedbackMessage = null;
  }

  private confirmModelEdit(): void {
    const entry = this.getSelectedEntry();
    if (!entry) return;

    const models = this.callbacks.getAvailableModels(entry.cliType).models;
    const selectedModel = models[this.editCursor];
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
  }

  private confirmEffortEdit(): void {
    const entry = this.getSelectedEntry();
    if (!entry || !this.pendingModelId) return;

    const effortLevels = this.getEffortLevels(entry.cliType, this.pendingModelId);
    const selectedEffort = effortLevels[this.editCursor];
    if (!selectedEffort) return;

    const selection: { model: string; effort?: string } = {
      model: this.pendingModelId,
      effort: selectedEffort,
    };

    void this.commitSelection(entry, selection);
  }

  private resetSelectedBackend(): void {
    const entry = this.getSelectedEntry();
    if (!entry) return;

    if (!entry.isCustom) {
      this.feedbackMessage = `${entry.displayName}은 이미 origin 설정입니다.`;
      this.tui.requestRender();
      return;
    }

    this.callbacks.resetBackendConfig(entry.cliType);
    this.feedbackMessage = `${entry.displayName} 설정을 origin으로 초기화했습니다.`;
    this.tui.requestRender();
  }

  private cancelEdit(): void {
    this.resetEditState();
    this.feedbackMessage = null;
  }

  private async commitSelection(
    entry: BackendEntry,
    selection: { model: string; effort?: string },
  ): Promise<void> {
    const cliType = toTaskForceCliType(entry.cliType);
    if (!cliType) {
      this.failSelection(`지원하지 않는 backend입니다 (${entry.cliType}).`);
      return;
    }

    const modelIds = new Set(this.callbacks.getAvailableModels(cliType).models.map((model) => model.modelId));
    if (!modelIds.has(selection.model)) {
      this.failSelection(`${entry.displayName} 모델 선택이 유효하지 않습니다.`);
      return;
    }

    const effortLevels = this.getEffortLevels(cliType, selection.model);
    if (selection.effort && !effortLevels.includes(selection.effort)) {
      this.failSelection(`${entry.displayName} effort 선택이 유효하지 않습니다.`);
      return;
    }

    if (effortLevels.length === 0) {
      delete selection.effort;
    }

    this.mode = "saving";
    this.tui.requestRender();

    try {
      await this.callbacks.updateBackendConfig(cliType, selection);
      this.feedbackMessage = `${entry.displayName} 설정을 저장했습니다.`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.feedbackMessage = `저장 실패: ${message}`;
    } finally {
      this.resetEditState();
      this.tui.requestRender();
    }
  }

  private failSelection(message: string): void {
    this.feedbackMessage = `저장 실패: ${message}`;
    this.resetEditState();
    this.tui.requestRender();
  }

  private getEffortLevels(cliType: string, modelId: string): string[] {
    const reasoning = this.callbacks.getEffort(cliType, modelId);
    return reasoning.supported ? [...(reasoning.levels ?? [])] : [];
  }

  private getDefaultEffort(cliType: string, modelId: string): string | null {
    const reasoning = this.callbacks.getEffort(cliType, modelId);
    if (!reasoning.supported) return null;
    return reasoning.default ?? reasoning.levels?.[0] ?? null;
  }

  private getFooterHint(): string {
    if (this.mode === "saving") return "저장 중...";
    if (this.mode === "browse") return "↑↓ select  Enter edit  R reset  Esc close";
    return "↑↓ select  Enter confirm  Esc cancel";
  }

  private resetEditState(): void {
    this.mode = "browse";
    this.pendingModelId = null;
    this.editCursor = 0;
  }
}

function toTaskForceCliType(value: string): TaskForceCliType | null {
  return (TASKFORCE_CLI_TYPES as readonly string[]).includes(value) ? value as TaskForceCliType : null;
}

function resolveEditorCardWidth(width: number, minWidth: number): number {
  return Math.max(minWidth, width);
}
