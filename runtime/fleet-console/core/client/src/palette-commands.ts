import type { LocalizedText, Translate } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";

import { getCommandBandDocked } from "./fullscreen-band-store.js";
import { getGlobalSettingsStoreState } from "./global-settings-store.js";
import type { CoreMessageKey } from "./i18n/index.js";
import { searchTokens } from "./operation-search.js";
import { resolveOperationActivity } from "./operation-activity.js";
import type { ConsoleState, ThemeId } from "./types.js";
import { resolveConsoleLanguage } from "./whatsnew-i18n.js";

export interface PaletteRailPanelInfo {
  readonly id: string;
  readonly title: LocalizedText;
}

export type PaletteCommandAction =
  | { readonly kind: "undo-close" }
  | { readonly kind: "switch-theater"; readonly theaterId: string }
  | { readonly kind: "new-theater" }
  | { readonly kind: "new-operation" }
  | { readonly kind: "resume-operation"; readonly operationId: string }
  | { readonly kind: "close-operation"; readonly operationId: string }
  | { readonly kind: "minimize-all-operations" }
  | { readonly kind: "fit-all-panels" }
  | { readonly kind: "toggle-triage-mode" }
  | { readonly kind: "toggle-formation" }
  | { readonly kind: "toggle-station-keeping" }
  | { readonly kind: "toggle-status-axis" }
  | { readonly kind: "open-rail-panel"; readonly panelId: string }
  | { readonly kind: "toggle-rail" }
  | { readonly kind: "toggle-sidebar" }
  | { readonly kind: "toggle-command-band-dock" }
  | { readonly kind: "switch-theme"; readonly theme: ThemeId }
  | { readonly kind: "open-settings" }
  | { readonly kind: "open-keyboard-shortcuts" }
  | { readonly kind: "rename-operation"; readonly operationId: string }
  | { readonly kind: "assign-operation-group"; readonly operationId: string }
  | { readonly kind: "set-operation-accent"; readonly operationId: string }
  | { readonly kind: "minimize-operation"; readonly operationId: string }
  | { readonly kind: "whats-new" }
  | { readonly kind: "forget-theater"; readonly theaterId: string };

export interface PaletteCommandEntry {
  readonly commandId: string;
  readonly label: string;
  readonly current: boolean;
  readonly action: PaletteCommandAction;
}

export interface PaletteCommandMatch {
  readonly score: number;
  readonly exactTokens: number;
  readonly matchedIndices: readonly number[];
}

export interface ScoredPaletteCommand {
  readonly command: PaletteCommandEntry;
  readonly score: number;
  readonly exactTokens: number;
  readonly matchedIndices: readonly number[];
}

type T = Translate<CoreMessageKey>;

function buildPaletteThemes(t: T): readonly { readonly id: ThemeId; readonly label: string }[] {
  return [
    { id: "instrument", label: t("palette.theme.instrument") },
    { id: "maritime", label: t("palette.theme.maritime") },
    { id: "carbon", label: t("palette.theme.carbon") },
    { id: "whites", label: t("palette.theme.whites") },
  ];
}

export function isCommandModeInput(value: string): boolean {
  return value.startsWith(">");
}

export function commandModeQuery(value: string): string {
  return value.slice(1);
}

export function buildPaletteCommands(
  current: ConsoleState,
  railPanels: readonly PaletteRailPanelInfo[],
  t: T,
  options?: { readonly canUndoLastClose?: boolean },
): readonly PaletteCommandEntry[] {
  const commands: PaletteCommandEntry[] = [];
  const language = resolveActiveLocale();
  const activeTheater = current.theaters.find((theater) => theater.id === current.activeTheaterId) ?? null;
  const activeOperation = current.operations.find(
    (operation) => operation.id === current.activeOperationId && operation.theaterId === current.activeTheaterId,
  ) ?? null;
  if (options?.canUndoLastClose === true) {
    commands.push({
      commandId: "undo-close",
      label: t("palette.undoClose"),
      current: false,
      action: { kind: "undo-close" },
    });
  }
  for (const theater of current.theaters) {
    commands.push({
      commandId: `switch-theater:${theater.id}`,
      label: t("palette.switchTheater", { label: theater.label }),
      current: theater.id === current.activeTheaterId,
      action: { kind: "switch-theater", theaterId: theater.id },
    });
  }
  commands.push({
    commandId: "new-theater",
    label: t("palette.newTheater"),
    current: false,
    action: { kind: "new-theater" },
  });
  if (activeTheater) {
    commands.push({
      commandId: "new-operation",
      label: t("palette.newOperation", { label: activeTheater.label }),
      current: false,
      action: { kind: "new-operation" },
    });
    // per-Operation 액션은 활성 Theater로 한정한다 — 팔레트 잡음을 막고 세션 위생 작업의 80%를 커버한다.
    // Resume은 dormant(복원 후 미기동) Operation에만 제안한다.
    const theaterOperations = current.operations.filter((operation) => operation.theaterId === activeTheater.id);
    for (const operation of theaterOperations) {
      if (resolveOperationActivity(operation, current.operationRuntime) === "ended") {
        commands.push({
          commandId: `resume-operation:${operation.id}`,
          label: t("palette.resumeOperation", { title: operation.title }),
          current: false,
          action: { kind: "resume-operation", operationId: operation.id },
        });
      }
      commands.push({
        commandId: `close-operation:${operation.id}`,
        label: t("palette.closeOperation", { title: operation.title }),
        current: false,
        action: { kind: "close-operation", operationId: operation.id },
      });
    }
    if (theaterOperations.length > 0) {
      commands.push({
        commandId: "minimize-all-operations",
        label: t("palette.minimizeAll"),
        current: false,
        action: { kind: "minimize-all-operations" },
      });
      commands.push({
        commandId: "fit-all-panels",
        label: t("palette.fitAllPanels"),
        current: false,
        action: { kind: "fit-all-panels" },
      });
    }
    commands.push({
      commandId: "toggle-triage-mode",
      label: t("palette.toggleTriage"),
      current: false,
      action: { kind: "toggle-triage-mode" },
    });
    commands.push({
      commandId: "toggle-formation",
      label: t("palette.toggleFormation"),
      current: false,
      action: { kind: "toggle-formation" },
    });
    commands.push({
      commandId: "toggle-station-keeping",
      label: t("palette.toggleStationKeeping"),
      current: false,
      action: { kind: "toggle-station-keeping" },
    });
    commands.push({
      commandId: "toggle-status-axis",
      label: t("palette.toggleStatusAxis"),
      current: false,
      action: { kind: "toggle-status-axis" },
    });
  }
  if (activeOperation) {
    commands.push(
      {
        commandId: "rename-operation",
        label: t("palette.renameOperation"),
        current: false,
        action: { kind: "rename-operation", operationId: activeOperation.id },
      },
      {
        commandId: "assign-operation-group",
        label: t("palette.assignGroup"),
        current: false,
        action: { kind: "assign-operation-group", operationId: activeOperation.id },
      },
      {
        commandId: "set-operation-accent",
        label: t("palette.setAccent"),
        current: false,
        action: { kind: "set-operation-accent", operationId: activeOperation.id },
      },
      {
        commandId: "minimize-operation",
        label: t("palette.minimizeOperation"),
        current: false,
        action: { kind: "minimize-operation", operationId: activeOperation.id },
      },
    );
  }
  for (const panel of railPanels) {
    commands.push({
      commandId: `open-rail-panel:${panel.id}`,
      label: t("palette.openPanel", { title: resolveLocalizedText(panel.title, language) }),
      current: false,
      action: { kind: "open-rail-panel", panelId: panel.id },
    });
  }
  commands.push({
    commandId: "toggle-rail",
    label: t("palette.toggleRail"),
    current: false,
    action: { kind: "toggle-rail" },
  });
  commands.push({
    commandId: "toggle-sidebar",
    label: t("palette.toggleSidebar"),
    current: false,
    action: { kind: "toggle-sidebar" },
  });
  // 전체화면에서 밴드가 숨은 동안 그 안의 토글은 inert라 닿지 않는다 — 팔레트가 표면 밖 경로다.
  // 라벨은 저장된 선호를 따른다: 이 항목은 전환이므로 한 방향으로만 읽히면 이미 켜 둔 사용자가
  // 켜는 줄 알고 골랐다가 밴드를 끄게 된다. current는 false로 둔다 — 전환 항목은 배지 대상이 아니고,
  // true면 팔레트가 이미 적용된 선택으로 보아 실행을 건너뛴다.
  commands.push({
    commandId: "toggle-command-band-dock",
    label: t(getCommandBandDocked() ? "palette.stopKeepingCommandBandVisible" : "palette.keepCommandBandVisible"),
    current: false,
    action: { kind: "toggle-command-band-dock" },
  });
  for (const theme of buildPaletteThemes(t)) {
    commands.push({
      commandId: `switch-theme:${theme.id}`,
      label: t("palette.switchTheme", { label: theme.label }),
      current: theme.id === current.activeTheme,
      action: { kind: "switch-theme", theme: theme.id },
    });
  }
  commands.push({
    commandId: "open-settings",
    label: t("palette.openSettings"),
    current: false,
    action: { kind: "open-settings" },
  });
  commands.push({
    commandId: "open-keyboard-shortcuts",
    label: t("palette.openKeyboardShortcuts"),
    current: false,
    action: { kind: "open-keyboard-shortcuts" },
  });
  if (current.releaseNotes.length > 0) {
    commands.push({
      commandId: "whats-new",
      label: t("palette.whatsNew"),
      current: false,
      action: { kind: "whats-new" },
    });
  }
  for (const theater of current.theaters) {
    commands.push({
      commandId: `forget-theater:${theater.id}`,
      label: t("palette.forgetTheater", { label: theater.label }),
      current: false,
      action: { kind: "forget-theater", theaterId: theater.id },
    });
  }
  return commands;
}

export function fuzzyMatchPaletteLabel(label: string, query: string): PaletteCommandMatch | null {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return null;
  const { foldedLabel, foldMap } = foldPaletteLabel(label);
  const matchedIndices = new Set<number>();
  let score = 0;
  let exactTokens = 0;

  for (const token of tokens) {
    const exactStart = findBestExactStart(foldedLabel, token, label, foldMap);
    const foldedTokenIndices: number[] = [];
    if (exactStart !== -1) {
      for (let offset = 0; offset < token.length; offset += 1) {
        foldedTokenIndices.push(exactStart + offset);
      }
      score += 100;
      exactTokens += 1;
    } else {
      let searchFrom = 0;
      for (const character of token) {
        const matchedIndex = foldedLabel.indexOf(character, searchFrom);
        if (matchedIndex === -1) return null;
        for (let characterOffset = 0; characterOffset < character.length; characterOffset += 1) {
          foldedTokenIndices.push(matchedIndex + characterOffset);
        }
        searchFrom = matchedIndex + character.length;
      }
    }

    const tokenIndices = foldMap === null
      ? foldedTokenIndices
      : foldedTokenIndices
        .map((foldedIndex) => foldMap[foldedIndex]!)
        .filter((originalIndex, index, indices) => index === 0 || originalIndex !== indices[index - 1]);
    const scoreText = foldMap === null ? foldedLabel : label;
    for (let index = 0; index < tokenIndices.length; index += 1) {
      const matchedIndex = tokenIndices[index]!;
      const previousMatchedIndex = tokenIndices[index - 1];
      score += previousMatchedIndex !== undefined && matchedIndex === previousMatchedIndex + 1 ? 3 : 1;
      if (matchedIndex === 0 || scoreText[matchedIndex - 1] === " ") score += 2;
      if (foldMap !== null) matchedIndices.add(matchedIndex);
    }
  }

  return {
    score: score - label.length * 0.01,
    exactTokens,
    matchedIndices: [...matchedIndices].sort((left, right) => left - right),
  };
}

export function matchPaletteCommands(
  commands: readonly PaletteCommandEntry[],
  query: string,
): readonly ScoredPaletteCommand[] {
  if (searchTokens(query).length === 0) {
    return commands.map((command) => ({ command, score: 0, exactTokens: 0, matchedIndices: [] }));
  }
  return commands.flatMap((command, originalIndex) => {
    const match = fuzzyMatchPaletteLabel(command.label, query);
    return match ? [{ command, ...match, originalIndex }] : [];
  }).sort((left, right) =>
    right.exactTokens - left.exactTokens
    || right.score - left.score
    || left.originalIndex - right.originalIndex)
    .map(({ command, score, exactTokens, matchedIndices }) => ({ command, score, exactTokens, matchedIndices }));
}


export function filterPaletteCommands(commands: readonly PaletteCommandEntry[], query: string): readonly PaletteCommandEntry[] {
  if (searchTokens(query).length === 0) return commands;
  return matchPaletteCommands(commands, query).map(({ command }) => command);
}

function foldPaletteLabel(label: string): {
  readonly foldedLabel: string;
  readonly foldMap: readonly number[] | null;
} {
  const foldedLabel = label.toLocaleLowerCase();
  if (label.length > 2_000) {
    return { foldedLabel, foldMap: null };
  }

  const foldMap: number[] = [];
  let previousPrefixLength = 0;
  for (let originalIndex = 0; originalIndex < label.length; originalIndex += 1) {
    const nextPrefixLength = label.slice(0, originalIndex + 1).toLocaleLowerCase().length;
    for (let foldedIndex = previousPrefixLength; foldedIndex < nextPrefixLength; foldedIndex += 1) {
      foldMap.push(originalIndex);
    }
    previousPrefixLength = nextPrefixLength;
  }
  return foldMap.length === foldedLabel.length
    ? { foldedLabel, foldMap }
    : { foldedLabel, foldMap: null };
}

function findBestExactStart(
  foldedLabel: string,
  token: string,
  label: string,
  foldMap: readonly number[] | null,
): number {
  let firstStart = -1;
  let searchFrom = 0;
  while (searchFrom <= foldedLabel.length - token.length) {
    const start = foldedLabel.indexOf(token, searchFrom);
    if (start === -1) break;
    if (firstStart === -1) firstStart = start;
    const boundaryIndex = foldMap?.[start] ?? start;
    const boundaryText = foldMap === null ? foldedLabel : label;
    if (boundaryIndex === 0 || boundaryText[boundaryIndex - 1] === " ") return start;
    searchFrom = start + 1;
  }
  return firstStart;
}

function resolveActiveLocale() {
  const preference = getGlobalSettingsStoreState().state?.language ?? "auto";
  const navigatorLanguage =
    typeof navigator !== "undefined" && typeof navigator.language === "string"
      ? navigator.language.toLowerCase()
      : "";
  return resolveConsoleLanguage(preference, navigatorLanguage);
}
