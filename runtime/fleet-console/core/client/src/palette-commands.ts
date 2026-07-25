import type { LocalizedText, Translate } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";

import { getGlobalSettingsStoreState } from "./global-settings-store.js";
import { getT, type CoreMessageKey } from "./i18n/index.js";
import { searchTokens } from "./operation-search.js";
import { resolveOperationActivity } from "./operation-activity.js";
import type { ConsoleState, ThemeId } from "./types.js";
import { resolveConsoleLanguage } from "./whatsnew-i18n.js";

export interface PaletteRailPanelInfo {
  readonly id: string;
  readonly title: LocalizedText;
}

export type PaletteCommandAction =
  | { readonly kind: "switch-theater"; readonly theaterId: string }
  | { readonly kind: "new-operation" }
  | { readonly kind: "resume-operation"; readonly operationId: string }
  | { readonly kind: "close-operation"; readonly operationId: string }
  | { readonly kind: "minimize-all-operations" }
  | { readonly kind: "toggle-formation" }
  | { readonly kind: "toggle-status-axis" }
  | { readonly kind: "open-rail-panel"; readonly panelId: string }
  | { readonly kind: "toggle-rail" }
  | { readonly kind: "toggle-sidebar" }
  | { readonly kind: "switch-theme"; readonly theme: ThemeId }
  | { readonly kind: "open-settings" }
  | { readonly kind: "open-keyboard-shortcuts" }
  | { readonly kind: "rename-operation"; readonly operationId: string }
  | { readonly kind: "assign-operation-group"; readonly operationId: string }
  | { readonly kind: "set-operation-accent"; readonly operationId: string }
  | { readonly kind: "minimize-operation"; readonly operationId: string }
  | { readonly kind: "whats-new" };

export interface PaletteCommandEntry {
  readonly commandId: string;
  readonly label: string;
  readonly current: boolean;
  readonly action: PaletteCommandAction;
}

type T = Translate<CoreMessageKey>;

export function buildPaletteThemes(t: T): readonly { readonly id: ThemeId; readonly label: string }[] {
  return [
    { id: "instrument", label: t("palette.theme.instrument") },
    { id: "maritime", label: t("palette.theme.maritime") },
    { id: "carbon", label: t("palette.theme.carbon") },
  ];
}

export function isCommandModeInput(value: string): boolean {
  return value.startsWith(">");
}

export function commandModeQuery(value: string): string {
  return value.slice(1);
}

export function buildPaletteCommands(current: ConsoleState, railPanels: readonly PaletteRailPanelInfo[]): readonly PaletteCommandEntry[] {
  const t = consoleT();
  const commands: PaletteCommandEntry[] = [];
  const language = resolveActiveLocale();
  const activeTheater = current.theaters.find((theater) => theater.id === current.activeTheaterId) ?? null;
  const activeOperation = current.operations.find(
    (operation) => operation.id === current.activeOperationId && operation.theaterId === current.activeTheaterId,
  ) ?? null;
  for (const theater of current.theaters) {
    commands.push({
      commandId: `switch-theater:${theater.id}`,
      label: t("palette.switchTheater", { label: theater.label }),
      current: theater.id === current.activeTheaterId,
      action: { kind: "switch-theater", theaterId: theater.id },
    });
  }
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
      if (resolveOperationActivity(operation, current.operationStatus) === "dormant") {
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
    }
    commands.push({
      commandId: "toggle-formation",
      label: t("palette.toggleFormation"),
      current: false,
      action: { kind: "toggle-formation" },
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
  return commands;
}

export function filterPaletteCommands(commands: readonly PaletteCommandEntry[], query: string): readonly PaletteCommandEntry[] {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return commands;
  return commands.filter((command) => {
    const haystack = command.label.toLocaleLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

function resolveActiveLocale() {
  const preference = getGlobalSettingsStoreState().state?.language ?? "auto";
  const navigatorLanguage =
    typeof navigator !== "undefined" && typeof navigator.language === "string"
      ? navigator.language.toLowerCase()
      : "";
  return resolveConsoleLanguage(preference, navigatorLanguage);
}

function consoleT(): T {
  return getT(resolveActiveLocale());
}
