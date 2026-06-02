import {
  PROVIDER_BG_ANSI_COLORS,
  PROVIDER_ANSI_COLORS,
  SUBAGENT_PRESENTATION_BG_ANSI,
  SUBAGENT_PRESENTATION_ANSI,
} from "../../styles/carriers.js";
import { CLI_DISPLAY_NAMES } from "@dotobokuri/fleet-carriers";
import {
  truncateToWidth,
  visibleWidth,
  type FleetPtyTheme,
} from "../../controls/index.js";
import { TASKFORCE_BADGE_COLOR } from "../../mission-bridge/job-bar/constants.js";
import { centerText } from "../welcome.js";

import type { RenameState, StatusOverlayViewModel } from "./render-types.js";
import type { BatchCliChoice, CarrierCliType, CarrierStatusEntry, CliModelInfo, OverlayState } from "./types.js";

export interface CarrierStatusRenderModel {
  readonly expandedCarrierId: string | null;
  readonly feedbackMessage: string | null;
  readonly renameState: RenameState | null;
  readonly state: OverlayState;
  readonly viewModel: StatusOverlayViewModel;
}

export interface CarrierStatusRenderDeps {
  readonly getAvailableModels: (cliType: CarrierCliType) => CliModelInfo;
  readonly getBatchCliChoices: (excludeCli?: CarrierCliType) => BatchCliChoice[];
  readonly getDefaultEffort: (cliType: CarrierCliType, modelId: string) => string | null;
  readonly getModelEffortLevels: (cliType: CarrierCliType, modelId: string) => string[];
  readonly theme: FleetPtyTheme;
}

interface CarrierRosterCellLine {
  readonly bg?: string;
  readonly text: string;
}

type CarrierRosterDisplayLine =
  | { readonly kind: "blank" }
  | { readonly kind: "cell"; readonly line: CarrierRosterCellLine }
  | { readonly kind: "center"; readonly text: string };

const ANSI_RESET = "\x1b[0m";
const INDENT = "    ";
const SLOT_WIDTH = 4;
const NAME_WIDTH = 12;
const MIN_CELL_WIDTH = 40;

export function renderCarrierStatusOverlay(width: number, model: CarrierStatusRenderModel, deps: CarrierStatusRenderDeps): string[] {
  const body: CarrierRosterDisplayLine[] = [
    { kind: "center", text: deps.theme.accent("Carrier Roster") },
    { kind: "blank" },
  ];

  if (model.state.kind === "batchFrom" || model.state.kind === "batchTo") {
    body.push(...buildBatchCliPanelLines(model.state, deps).map(toCellLine), { kind: "blank" });
  }

  for (let gi = 0; gi < model.viewModel.groupedEntries.length; gi++) {
    const group = model.viewModel.groupedEntries[gi]!;
    body.push(toCellLine(`${group.color}◇${ANSI_RESET} ${group.color}${group.header}${ANSI_RESET}`), { kind: "blank" });

    for (const entry of group.entries) {
      const isSelected = entry.carrierId === model.viewModel.selectedCarrierId;
      body.push({
        kind: "cell",
        line: {
          bg: isSelected ? getEntryBgColorForEntry(entry) : undefined,
          text: withIndent(renderEntryLine(entry, isSelected, deps)),
        },
      });

      if (isSelected && shouldRenderEntryEditor(model.state, entry.carrierId)) {
        body.push(...buildEntryEditorLines(entry, model.state, deps).map(toIndentedCellLine));
      }

      if (isSelected && model.renameState?.carrierId === entry.carrierId) {
        body.push(...buildRenameEditorLines(model.renameState, deps.theme).map(toIndentedCellLine));
      }

      if (isSelected && model.expandedCarrierId === entry.carrierId) {
        body.push(...buildDetailRows(entry, Math.max(20, width - 8), deps).map(toIndentedCellLine));
      }
    }

    if (gi < model.viewModel.groupedEntries.length - 1) {
      body.push({ kind: "blank" });
    }
  }

  body.push({ kind: "blank" });
  if (model.feedbackMessage) {
    const tone = isWarningFeedback(model.feedbackMessage) ? deps.theme.warning : deps.theme.accent;
    body.push({ kind: "center", text: tone(model.feedbackMessage) }, { kind: "blank" });
  }

  body.push({ kind: "center", text: deps.theme.dim(getFooterHint(model)) });
  return renderDisplayLines(body, width);
}

export function estimateCarrierStatusRows(
  model: CarrierStatusRenderModel,
  deps: CarrierStatusRenderDeps,
): number {
  let rows = 0;
  for (const group of model.viewModel.groupedEntries) {
    rows += 3 + group.entries.length;
  }
  if (model.state.kind === "batchFrom" || model.state.kind === "batchTo") {
    rows += buildBatchCliPanelLines(model.state, deps).length + 1;
  }
  const selected = getSelectedEntry(model);
  if (selected && shouldRenderEntryEditor(model.state, selected.carrierId)) {
    rows += getEntryEditorOptions(selected, model.state, deps).length;
  }
  if (model.renameState) rows += 2;
  if (selected && model.expandedCarrierId === selected.carrierId) rows += 4;
  return rows;
}

export function clampCarrierStatusOverlayRows(maxRows: number, cardRows: number): number {
  return Math.min(Math.max(0, maxRows), Math.max(0, cardRows));
}

export function getModelLabel(provider: CliModelInfo, modelId: string): string {
  return provider.models.find((model) => model.modelId === modelId)?.name ?? modelId;
}

function buildBatchCliPanelLines(state: OverlayState, deps: CarrierStatusRenderDeps): string[] {
  if (state.kind !== "batchFrom" && state.kind !== "batchTo") return [];
  const title = state.kind === "batchFrom" ? "  Batch CLI: FROM 선택" : "  Batch CLI: TO 선택";
  const lines = [deps.theme.accent(title)];
  if (state.kind === "batchTo") {
    const fromChoice = deps.getBatchCliChoices().find((choice) => choice.cliType === state.fromCli);
    if (fromChoice) lines.push(`  FROM: ${getCliDisplayName(fromChoice.cliType)} (${fromChoice.carrierCount} carriers)`);
  }
  for (let i = 0; i < state.choices.length; i++) {
    const choice = state.choices[i]!;
    const cursor = i === state.cursor ? "▸" : " ";
    const content = `  ${cursor} ○ ${choice.label}`;
    lines.push(choice.carrierCount === 0 && state.kind === "batchFrom" ? deps.theme.dim(content) : content);
  }
  return lines;
}

function renderDisplayLines(lines: readonly CarrierRosterDisplayLine[], width: number): string[] {
  const cellWidth = resolveCellWidth(lines);
  return lines.map((line) => {
    if (line.kind === "blank") {
      return "";
    }
    if (line.kind === "center") {
      return centerText(line.text, width);
    }
    return centerText(renderCellLine(line.line, cellWidth), width);
  });
}

function resolveCellWidth(lines: readonly CarrierRosterDisplayLine[]): number {
  const lineWidths = lines
    .filter((line): line is Extract<CarrierRosterDisplayLine, { readonly kind: "cell" }> => line.kind === "cell")
    .map((line) => visibleWidth(line.line.text));
  return Math.max(MIN_CELL_WIDTH, ...lineWidths);
}

function renderCellLine(line: CarrierRosterCellLine, cellWidth: number): string {
  const padded = padEndVisible(truncateToWidth(line.text, cellWidth), cellWidth);
  return applyLineBg(padded, line.bg);
}

function toCellLine(text: string): CarrierRosterDisplayLine {
  return {
    kind: "cell",
    line: { text },
  };
}

function toIndentedCellLine(text: string): CarrierRosterDisplayLine {
  return toCellLine(withIndent(text));
}

function withIndent(text: string): string {
  return `${INDENT}${text}`;
}

function padEndVisible(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

function buildDetailRows(entry: CarrierStatusEntry, innerWidth: number, deps: CarrierStatusRenderDeps): string[] {
  const provider = deps.getAvailableModels(entry.cliType);
  const modelLabel = getModelLabel(provider, entry.model);
  const labelWidth = 8;
  const valueWidth = Math.max(10, innerWidth - 10 - labelWidth);
  const lines: string[] = [];
  const detailLine = (label: string, value: string) => {
    lines.push(`      ${deps.theme.dim(label.padEnd(labelWidth, " "))} ${value}`);
  };
  detailLine("model", modelLabel);
  detailLine("cli", getCliDisplayName(entry.cliType));
  detailLine("role", entry.role ?? "-");
  const desc = wrapText(entry.roleDescription ?? "-", valueWidth);
  for (let i = 0; i < desc.length; i++) {
    detailLine(i === 0 ? "desc" : "", desc[i]!);
  }
  return lines;
}

function buildEntryEditorLines(entry: CarrierStatusEntry, state: OverlayState, deps: CarrierStatusRenderDeps): string[] {
  const options = getEntryEditorOptions(entry, state, deps);
  const currentValue = getEntryEditorCurrentValue(entry, state, deps);
  const cursor = "cursor" in state ? state.cursor : 0;
  return options.map((option, index) => {
    const cursorToken = index === cursor ? `${getCliEntryColor(entry.cliType)}▸${ANSI_RESET}` : " ";
    const marker = option.value === currentValue ? "●" : "○";
    return `      ${cursorToken} ${marker} ${option.label}`;
  });
}

function buildRenameEditorLines(renameState: RenameState, theme: FleetPtyTheme): string[] {
  const draft = renameState.draft.length > 0 ? renameState.draft : theme.dim("(empty resets default)");
  return [
    theme.accent("      이름 변경"),
    `      ▸ ${draft}`,
  ];
}

function getEntryEditorCurrentValue(
  entry: CarrierStatusEntry,
  state: OverlayState,
  deps: CarrierStatusRenderDeps,
): string | null {
  switch (state.kind) {
    case "model":
      return entry.model;
    case "effort":
      return entry.effort ?? deps.getDefaultEffort(entry.cliType, state.pendingModel);
    case "cliType":
      return entry.cliType;
    case "batchFrom":
    case "batchTo":
    case "browse":
    case "saving":
      return null;
  }
}

function getEntryEditorOptions(
  entry: CarrierStatusEntry,
  state: OverlayState,
  deps: CarrierStatusRenderDeps,
): Array<{ value: string; label: string }> {
  switch (state.kind) {
    case "model":
      return state.choices.map((modelId) => ({
        label: getModelLabel(deps.getAvailableModels(entry.cliType), modelId),
        value: modelId,
      }));
    case "effort":
      return state.choices.map((level) => ({ label: level, value: level }));
    case "cliType":
      return state.choices.map((choice) => ({ label: choice.label, value: choice.value }));
    case "batchFrom":
    case "batchTo":
    case "browse":
    case "saving":
      return [];
  }
}

function getEntryBgColor(cliType: CarrierCliType): string | undefined {
  return PROVIDER_BG_ANSI_COLORS[cliType];
}

function isWarningFeedback(message: string): boolean {
  return message.startsWith("저장 실패") || message.startsWith("경고:");
}

function getEntryColor(entry: CarrierStatusEntry): string {
  if (entry.subagentMode) return getSubagentSignatureColor();
  if (entry.taskForceBackendCount >= 2) return TASKFORCE_BADGE_COLOR;
  return PROVIDER_ANSI_COLORS[entry.cliType] ?? "";
}

function getEntryBgColorForEntry(entry: CarrierStatusEntry): string | undefined {
  return entry.subagentMode ? getSubagentSignatureBgColor() : getEntryBgColor(entry.cliType);
}

function getCliEntryColor(cliType: CarrierCliType): string {
  return PROVIDER_ANSI_COLORS[cliType] ?? "";
}

function getCliDisplayName(cliType: string): string {
  return CLI_DISPLAY_NAMES[cliType] ?? cliType;
}

function getSubagentSignatureColor(): string {
  return SUBAGENT_PRESENTATION_ANSI;
}

function getSubagentSignatureBgColor(): string | undefined {
  return SUBAGENT_PRESENTATION_BG_ANSI;
}

function getFooterHint(model: CarrierStatusRenderModel): string {
  if (model.renameState) return "이름 입력  Enter save  Esc cancel  Backspace delete  empty = reset";
  if (model.state.kind === "saving") return "저장 중...";
  if (model.state.kind === "browse") return "↑↓ select  Enter edit  s subagent  N rename  c cli  C batch  R reset  t tf  Tab  Esc";
  return "↑↓ select  Enter confirm  Esc cancel";
}

function getSelectedEntry(model: CarrierStatusRenderModel): CarrierStatusEntry | null {
  const selectedCarrierId = model.viewModel.selectedCarrierId;
  return selectedCarrierId
    ? model.viewModel.flatEntries.find((entry) => entry.carrierId === selectedCarrierId) ?? null
    : null;
}

function renderEntryLine(entry: CarrierStatusEntry, isSelected: boolean, deps: CarrierStatusRenderDeps): string {
  const dim = deps.theme.dim;
  const slotStr = `#${entry.slot}`;
  const slotPad = " ".repeat(Math.max(0, SLOT_WIDTH - slotStr.length));
  const namePad = " ".repeat(Math.max(0, NAME_WIDTH - visibleWidth(entry.displayName)));
  const nameColor = getEntryColor(entry);
  const selectedPrefix = isSelected ? `${nameColor}▸${ANSI_RESET}` : " ";
  const coloredName = `${nameColor}${entry.displayName}${ANSI_RESET}`;
  const modelLabel = getModelLabel(deps.getAvailableModels(entry.cliType), entry.model);
  const modelStr = entry.isDefault ? dim(modelLabel) : modelLabel;
  const effortSupported = deps.getModelEffortLevels(entry.cliType, entry.model).length > 0;
  const effortStr = effortSupported && entry.effort ? `${dim(" · ")}${entry.effort}` : "";
  const roleStr = entry.role ? dim(`  (${entry.role})`) : "";
  const tfTag = entry.taskForceBackendCount >= 2
    ? `  ${TASKFORCE_BADGE_COLOR}[TF:${entry.taskForceBackendCount}]${ANSI_RESET}`
    : "";
  // subagentMode일 때 [SA] 뱃지만 표시 (pending '*' 마커 제거)
  const subagentTag = entry.subagentMode
    ? `  ${getSubagentSignatureColor()}[SA]${ANSI_RESET}`
    : "";
  return `${selectedPrefix} ${dim(slotStr)}${slotPad}${coloredName}${namePad}${modelStr}${effortStr}${roleStr}${subagentTag}${tfTag}`;
}

function applyLineBg(line: string, bg: string | undefined): string {
  if (!bg) return line;
  return `${bg}${line.replaceAll(ANSI_RESET, `${ANSI_RESET}${bg}`)}${ANSI_RESET}`;
}

function shouldRenderEntryEditor(state: OverlayState, carrierId: string): boolean {
  return (state.kind === "model" || state.kind === "effort" || state.kind === "cliType")
    && state.carrierId === carrierId;
}

function wrapText(text: string, maxWidth: number): string[] {
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
