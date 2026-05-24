import {
  CARRIER_BG_COLORS,
  CARRIER_COLORS,
  CLI_DISPLAY_NAMES,
} from "@dotobokuri/fleet-carriers";
import {
  createOverlayFrame,
  MIN_DEDICATED_ROWS,
  visibleWidth,
  type FleetPtyTheme,
} from "@dotobokuri/fleet-tui/pty";

import type { RenameState, StatusOverlayViewModel } from "./overlay-types.js";
import type { BatchCliChoice, CarrierCliType, CarrierStatusEntry, CliModelInfo, OverlayState } from "./types.js";

const ANSI_RESET = "\x1b[0m";
const SLOT_WIDTH = 4;
const NAME_WIDTH = 12;
const CARRIER_STATUS_FRAME_ROWS = 3;
const CARRIER_STATUS_EXTRA_BODY_ROWS = 6;

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

export function renderCarrierStatusOverlay(width: number, model: CarrierStatusRenderModel, deps: CarrierStatusRenderDeps): string[] {
  const body: Array<string | { bg?: string; text: string }> = [];

  if (model.state.kind === "batchFrom" || model.state.kind === "batchTo") {
    body.push(...buildBatchCliPanelLines(model.state, deps), "");
  }

  for (let gi = 0; gi < model.viewModel.groupedEntries.length; gi++) {
    const group = model.viewModel.groupedEntries[gi]!;
    body.push(`  ${group.color}◇${ANSI_RESET} ${group.color}${group.header}${ANSI_RESET}`);

    for (const entry of group.entries) {
      const isSelected = entry.carrierId === model.viewModel.selectedCarrierId;
      body.push({
        bg: isSelected ? getEntryBgColor(entry.cliType) : undefined,
        text: renderEntryLine(entry, isSelected, deps),
      });

      if (isSelected && shouldRenderEntryEditor(model.state, entry.carrierId)) {
        body.push(...buildEntryEditorLines(entry, model.state, deps));
      }

      if (isSelected && model.renameState?.carrierId === entry.carrierId) {
        body.push(...buildRenameEditorLines(model.renameState, deps.theme));
      }

      if (isSelected && model.expandedCarrierId === entry.carrierId) {
        body.push(...buildDetailRows(entry, Math.max(20, width - 8), deps));
      }
    }

    if (gi < model.viewModel.groupedEntries.length - 1) {
      body.push("");
    }
  }

  body.push("");
  if (model.feedbackMessage) {
    const tone = model.feedbackMessage.startsWith("저장 실패") ? deps.theme.warning : deps.theme.accent;
    body.push(tone(model.feedbackMessage), "");
  }

  return createOverlayFrame({
    body,
    footer: getFooterHint(model),
    theme: deps.theme,
    title: "Carrier Status",
    width,
  });
}

export function estimateCarrierStatusRows(
  model: CarrierStatusRenderModel,
  deps: CarrierStatusRenderDeps,
): number {
  let rows = 0;
  for (const group of model.viewModel.groupedEntries) {
    rows += 2 + group.entries.length;
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
  const maxFleetRows = Math.max(0, maxRows - MIN_DEDICATED_ROWS);
  return Math.min(maxFleetRows, Math.max(0, cardRows));
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
    const cursorToken = index === cursor ? `${getEntryColor(entry.cliType)}▸${ANSI_RESET}` : " ";
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
  return CARRIER_BG_COLORS[cliType];
}

function getEntryColor(cliType: CarrierCliType): string {
  return CARRIER_COLORS[cliType] ?? "";
}

function getCliDisplayName(cliType: string): string {
  return CLI_DISPLAY_NAMES[cliType] ?? cliType;
}

function getFooterHint(model: CarrierStatusRenderModel): string {
  if (model.renameState) return "이름 입력  Enter save  Esc cancel  Backspace delete  empty = reset";
  if (model.state.kind === "saving") return "저장 중...";
  if (model.state.kind === "browse") return "↑↓ select  Enter edit  N rename  c cli  C batch  R reset  t tf  Tab  Esc";
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
  const nameColor = getEntryColor(entry.cliType);
  const selectedPrefix = isSelected ? `${nameColor}▸${ANSI_RESET}` : " ";
  const coloredName = `${nameColor}${entry.displayName}${ANSI_RESET}`;
  const modelLabel = getModelLabel(deps.getAvailableModels(entry.cliType), entry.model);
  const modelStr = entry.isDefault ? dim(modelLabel) : modelLabel;
  const effortSupported = deps.getModelEffortLevels(entry.cliType, entry.model).length > 0;
  const effortStr = effortSupported && entry.effort ? `${dim(" · ")}${entry.effort}` : "";
  const roleStr = entry.role ? dim(`  (${entry.role})`) : "";
  const tfTag = entry.taskForceBackendCount >= 2
    ? `  \x1b[38;2;100;180;255m[TF:${entry.taskForceBackendCount}]${ANSI_RESET}`
    : "";
  return `  ${selectedPrefix} ${dim(slotStr)}${slotPad}${coloredName}${namePad}${modelStr}${effortStr}${roleStr}${tfTag}`;
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
