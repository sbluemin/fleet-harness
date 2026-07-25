import { searchTokens } from "./operation-search.js";
import { resolveOperationActivity } from "./operation-activity.js";
import type { ConsoleState, ThemeId } from "./types.js";

export interface PaletteRailPanelInfo {
  readonly id: string;
  readonly title: string;
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
  | { readonly kind: "whats-new" };

export interface PaletteCommandEntry {
  readonly commandId: string;
  readonly label: string;
  readonly current: boolean;
  readonly action: PaletteCommandAction;
}

export const PALETTE_THEMES: readonly { readonly id: ThemeId; readonly label: string }[] = [
  { id: "instrument", label: "Instrument" },
  { id: "maritime", label: "Maritime" },
  { id: "carbon", label: "Carbon" },
];

export function isCommandModeInput(value: string): boolean {
  return value.startsWith(">");
}

export function commandModeQuery(value: string): string {
  return value.slice(1);
}

export function buildPaletteCommands(current: ConsoleState, railPanels: readonly PaletteRailPanelInfo[]): readonly PaletteCommandEntry[] {
  const commands: PaletteCommandEntry[] = [];
  const activeTheater = current.theaters.find((theater) => theater.id === current.activeTheaterId) ?? null;
  for (const theater of current.theaters) {
    commands.push({
      commandId: `switch-theater:${theater.id}`,
      label: `Switch theater: ${theater.label}`,
      current: theater.id === current.activeTheaterId,
      action: { kind: "switch-theater", theaterId: theater.id },
    });
  }
  if (activeTheater) {
    commands.push({
      commandId: "new-operation",
      label: `New Operation in ${activeTheater.label}`,
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
          label: `Resume operation: ${operation.title}`,
          current: false,
          action: { kind: "resume-operation", operationId: operation.id },
        });
      }
      commands.push({
        commandId: `close-operation:${operation.id}`,
        label: `Close operation: ${operation.title}`,
        current: false,
        action: { kind: "close-operation", operationId: operation.id },
      });
    }
    if (theaterOperations.length > 0) {
      commands.push({
        commandId: "minimize-all-operations",
        label: "Minimize all Operations",
        current: false,
        action: { kind: "minimize-all-operations" },
      });
    }
    commands.push({
      commandId: "toggle-formation",
      label: "Toggle Formation view",
      current: false,
      action: { kind: "toggle-formation" },
    });
    commands.push({
      commandId: "toggle-status-axis",
      label: "Toggle status axis",
      current: false,
      action: { kind: "toggle-status-axis" },
    });
  }
  for (const panel of railPanels) {
    commands.push({
      commandId: `open-rail-panel:${panel.id}`,
      label: `Open panel: ${panel.title}`,
      current: false,
      action: { kind: "open-rail-panel", panelId: panel.id },
    });
  }
  commands.push({
    commandId: "toggle-rail",
    label: "Toggle Activity Rail",
    current: false,
    action: { kind: "toggle-rail" },
  });
  commands.push({
    commandId: "toggle-sidebar",
    label: "Toggle sidebar",
    current: false,
    action: { kind: "toggle-sidebar" },
  });
  for (const theme of PALETTE_THEMES) {
    commands.push({
      commandId: `switch-theme:${theme.id}`,
      label: `Switch theme: ${theme.label}`,
      current: theme.id === current.activeTheme,
      action: { kind: "switch-theme", theme: theme.id },
    });
  }
  commands.push({
    commandId: "open-settings",
    label: "Open Settings",
    current: false,
    action: { kind: "open-settings" },
  });
  commands.push({
    commandId: "open-keyboard-shortcuts",
    label: "Open keyboard shortcuts",
    current: false,
    action: { kind: "open-keyboard-shortcuts" },
  });
  if (current.releaseNotes.length > 0) {
    commands.push({
      commandId: "whats-new",
      label: "What's new",
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
