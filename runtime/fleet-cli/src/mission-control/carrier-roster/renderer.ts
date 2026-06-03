import { CLI_DISPLAY_NAMES } from "@dotobokuri/fleet-carriers";

import {
  truncateToWidth,
  visibleWidth,
  type FleetPtyTheme,
} from "../../controls/index.js";
import { TASKFORCE_BADGE_COLOR } from "../../mission-bridge/job-bar/constants.js";
import {
  PROVIDER_BG_ANSI_COLORS,
  PROVIDER_ANSI_COLORS,
  SUBAGENT_PRESENTATION_BG_ANSI,
  SUBAGENT_PRESENTATION_ANSI,
} from "../../styles/carriers.js";
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
const ROSTER_ACTIONS_ID = "__roster_actions__";
const CARRIER_ACTION_LABELS = [
  "Edit Model",
  "Change CLI Type",
  "Rename",
  "Toggle Native(SubAgent)",
  "Open TaskForce",
  "Toggle Details",
] as const;
const ROSTER_ACTION_LABELS = [
  "Batch CLI Switch",
  "Reset CLI Types to Default",
] as const;

export function renderCarrierStatusOverlay(width: number, model: CarrierStatusRenderModel, deps: CarrierStatusRenderDeps): string[] {
  const body: CarrierRosterDisplayLine[] = [
    { kind: "center", text: deps.theme.accent("Carrier Roster") },
    { kind: "blank" },
  ];

  if (model.state.kind === "batchFrom" || model.state.kind === "batchTo") {
    body.push(...buildBatchCliPanelLines(model.state, deps), { kind: "blank" });
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
        body.push(...buildEntryEditorLines(entry, model.state, deps));
      }

      if (isSelected && model.renameState?.carrierId === entry.carrierId) {
        body.push(...buildRenameEditorLines(model.renameState, deps.theme));
      }

      if (isSelected && model.expandedCarrierId === entry.carrierId) {
        body.push(...buildDetailRows(entry, getDetailInnerWidth(width), deps).map((line) => toIndentedCellLine(line)));
      }
    }

    if (gi < model.viewModel.groupedEntries.length - 1) {
      body.push({ kind: "blank" });
    }
  }

  body.push({ kind: "blank" });
  body.push(toCellLine(renderRosterActionsRow(model.viewModel.selectedCarrierId === ROSTER_ACTIONS_ID, deps)));
  if (model.state.kind === "carrierActions") {
    body.push(...buildActionMenuLines("Carrier Actions", CARRIER_ACTION_LABELS, model.state.cursor, deps));
  }
  if (model.state.kind === "rosterActions") {
    body.push(...buildActionMenuLines("Roster Actions", ROSTER_ACTION_LABELS, model.state.cursor, deps));
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
  rows += 2;
  if (model.state.kind === "batchFrom" || model.state.kind === "batchTo") {
    rows += buildBatchCliPanelLines(model.state, deps).length + 1;
  }
  if (model.state.kind === "carrierActions") rows += CARRIER_ACTION_LABELS.length + 1;
  if (model.state.kind === "rosterActions") rows += ROSTER_ACTION_LABELS.length + 1;
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

export function getCarrierStatusFocusLine(width: number, model: CarrierStatusRenderModel, deps: CarrierStatusRenderDeps): number | undefined {
  let line = 2;
  if (model.state.kind === "batchFrom" || model.state.kind === "batchTo") {
    return line + getBatchChoiceLineOffset(buildBatchCliPanelLines(model.state, deps), model.state);
  }

  for (let gi = 0; gi < model.viewModel.groupedEntries.length; gi++) {
    const group = model.viewModel.groupedEntries[gi]!;
    line += 2;

    for (const entry of group.entries) {
      const entryLine = line;
      line++;
      if (entry.carrierId === model.viewModel.selectedCarrierId) {
        const entryFocusLine = getSelectedEntryFocusLine(entryLine, entry, model, deps);
        if (entryFocusLine !== undefined) return entryFocusLine;
        line += getSelectedEntryExtraRows(width, entry, model, deps);
      }
    }

    if (gi < model.viewModel.groupedEntries.length - 1) {
      line++;
    }
  }

  line++;
  const rosterActionsLine = line;
  if (model.viewModel.selectedCarrierId === ROSTER_ACTIONS_ID && model.state.kind === "browse") {
    return rosterActionsLine;
  }
  line++;
  if (model.state.kind === "carrierActions") {
    return line + 1 + clampCursor(model.state.cursor, CARRIER_ACTION_LABELS.length);
  }
  if (model.state.kind === "rosterActions") {
    return line + 1 + clampCursor(model.state.cursor, ROSTER_ACTION_LABELS.length);
  }
  return undefined;
}

export function getModelLabel(provider: CliModelInfo, modelId: string): string {
  return provider.models.find((model) => model.modelId === modelId)?.name ?? modelId;
}

function getBatchChoiceLineOffset(lines: readonly CarrierRosterDisplayLine[], state: Extract<OverlayState, { readonly kind: "batchFrom" | "batchTo" }>): number {
  const choiceStart = Math.max(0, lines.length - state.choices.length);
  return choiceStart + clampCursor(state.cursor, state.choices.length);
}

function getSelectedEntryFocusLine(
  entryLine: number,
  entry: CarrierStatusEntry,
  model: CarrierStatusRenderModel,
  deps: CarrierStatusRenderDeps,
): number | undefined {
  const state = model.state;
  if (shouldRenderEntryEditor(state, entry.carrierId) && "cursor" in state) {
    return entryLine + 1 + clampCursor(state.cursor, getEntryEditorOptions(entry, state, deps).length);
  }
  if (model.renameState?.carrierId === entry.carrierId) {
    return entryLine + 2;
  }
  if (state.kind === "browse" || state.kind === "saving") {
    return entryLine;
  }
  return undefined;
}

function getSelectedEntryExtraRows(
  width: number,
  entry: CarrierStatusEntry,
  model: CarrierStatusRenderModel,
  deps: CarrierStatusRenderDeps,
): number {
  let rows = 0;
  if (shouldRenderEntryEditor(model.state, entry.carrierId)) {
    rows += getEntryEditorOptions(entry, model.state, deps).length;
  }
  if (model.renameState?.carrierId === entry.carrierId) {
    rows += buildRenameEditorLines(model.renameState, deps.theme).length;
  }
  if (model.expandedCarrierId === entry.carrierId) {
    rows += buildDetailRows(entry, getDetailInnerWidth(width), deps).length;
  }
  return rows;
}

function clampCursor(cursor: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, cursor));
}

function buildBatchCliPanelLines(state: OverlayState, deps: CarrierStatusRenderDeps): CarrierRosterDisplayLine[] {
  if (state.kind !== "batchFrom" && state.kind !== "batchTo") return [];
  const title = state.kind === "batchFrom" ? "  Batch CLI: FROM 선택" : "  Batch CLI: TO 선택";
  const lines: CarrierRosterDisplayLine[] = [toCellLine(deps.theme.accent(title))];
  if (state.kind === "batchTo") {
    const fromChoice = deps.getBatchCliChoices().find((choice) => choice.cliType === state.fromCli);
    if (fromChoice) lines.push(toCellLine(`  FROM: ${getCliDisplayName(fromChoice.cliType)} (${fromChoice.carrierCount} carriers)`));
  }
  for (let i = 0; i < state.choices.length; i++) {
    const choice = state.choices[i]!;
    const cursor = i === state.cursor ? deps.theme.accent("▸") : " ";
    const content = `  ${cursor} ○ ${choice.label}`;
    lines.push(toCellLine(
      choice.carrierCount === 0 && state.kind === "batchFrom" ? deps.theme.dim(content) : content,
    ));
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
    return renderCellLine(line.line, cellWidth, width);
  });
}

function resolveCellWidth(lines: readonly CarrierRosterDisplayLine[]): number {
  const lineWidths = lines
    .filter((line): line is Extract<CarrierRosterDisplayLine, { readonly kind: "cell" }> => line.kind === "cell")
    .map((line) => visibleWidth(line.line.text));
  return Math.max(MIN_CELL_WIDTH, ...lineWidths);
}

function renderCellLine(line: CarrierRosterCellLine, cellWidth: number, width: number): string {
  const padded = padEndVisible(truncateToWidth(line.text, cellWidth), cellWidth);
  return centerText(applyLineBg(padded, line.bg), width);
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

function getDetailInnerWidth(width: number): number {
  return Math.max(20, width - 8);
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

function buildEntryEditorLines(entry: CarrierStatusEntry, state: OverlayState, deps: CarrierStatusRenderDeps): CarrierRosterDisplayLine[] {
  const options = getEntryEditorOptions(entry, state, deps);
  const currentValue = getEntryEditorCurrentValue(entry, state, deps);
  const cursor = "cursor" in state ? state.cursor : 0;
  return options.map((option, index) => {
    const cursorToken = index === cursor ? `${getCliEntryColor(entry.cliType)}▸${ANSI_RESET}` : " ";
    const marker = option.value === currentValue ? "●" : "○";
    return toIndentedCellLine(`      ${cursorToken} ${marker} ${option.label}`);
  });
}

function buildActionMenuLines(
  title: string,
  labels: readonly string[],
  cursor: number,
  deps: CarrierStatusRenderDeps,
): CarrierRosterDisplayLine[] {
  return [
    toIndentedCellLine(deps.theme.accent(`      ${title}`)),
    ...labels.map((label, index) => {
      const marker = index === cursor ? deps.theme.accent("▸") : " ";
      return toIndentedCellLine(`      ${marker} ${label}`);
    }),
  ];
}

function buildRenameEditorLines(renameState: RenameState, theme: FleetPtyTheme): CarrierRosterDisplayLine[] {
  const draft = renameState.draft.length > 0 ? renameState.draft : theme.dim("(empty resets default)");
  return [
    toIndentedCellLine(theme.accent("      이름 변경")),
    toIndentedCellLine(`      ${theme.accent("▸")} ${draft}`),
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
    case "carrierActions":
    case "rosterActions":
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
    case "carrierActions":
    case "rosterActions":
    case "saving":
      return [];
  }
}

function isWarningFeedback(message: string): boolean {
  return message.startsWith("저장 실패") || message.startsWith("경고:");
}

function getEntryColor(entry: CarrierStatusEntry): string {
  if (entry.subagentMode) return getSubagentSignatureColor();
  if (entry.taskForceBackendCount >= 2) return TASKFORCE_BADGE_COLOR;
  return PROVIDER_ANSI_COLORS[entry.cliType] ?? "";
}

function getEntryBgColor(cliType: CarrierCliType): string | undefined {
  return PROVIDER_BG_ANSI_COLORS[cliType];
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
  if (model.state.kind === "browse") return "↑↓ select  Enter actions  Esc back";
  if (model.state.kind === "carrierActions" || model.state.kind === "rosterActions") return "↑↓ select  Enter run  Esc back";
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
  const taskForceTag = entry.taskForceBackendCount >= 2
    ? `  ${TASKFORCE_BADGE_COLOR}[TF:${entry.taskForceBackendCount}]${ANSI_RESET}`
    : "";
  // subagentMode일 때 [SA] 뱃지만 표시 (pending '*' 마커 제거)
  const subagentTag = entry.subagentMode
    ? `  ${getSubagentSignatureColor()}[SA]${ANSI_RESET}`
    : "";
  return `${selectedPrefix} ${dim(slotStr)}${slotPad}${coloredName}${namePad}${modelStr}${effortStr}${roleStr}${subagentTag}${taskForceTag}`;
}

function renderRosterActionsRow(isSelected: boolean, deps: CarrierStatusRenderDeps): string {
  const marker = isSelected ? `${deps.theme.accent("▸")}` : " ";
  return `${marker} ${deps.theme.accent("Roster Actions")}`;
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
