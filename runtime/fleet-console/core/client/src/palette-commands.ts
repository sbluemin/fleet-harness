import type { ReactNode } from "react";

import type { LocalizedText, Translate } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";

import { CORE_SHORTCUT_COMMANDS } from "./shortcut-bindings.js";
import { getCommandBandDocked } from "./fullscreen-band-store.js";
import { isZenMode } from "./zen-mode.js";
import { getGlobalSettingsStoreState } from "./global-settings-store.js";
import { getT, type CoreMessageKey } from "./i18n/index.js";
import { fuzzyMatchPaletteLabel, searchTokens, type PaletteCommandMatch } from "./palette-match.js";

export { fuzzyMatchPaletteLabel, type PaletteCommandMatch } from "./palette-match.js";
import { resolveOperationActivity } from "./operation-activity.js";
import type { ConsoleState, ThemeId } from "./types.js";
import { resolveConsoleLanguage } from "./whatsnew-i18n.js";

export interface PaletteRailPanelInfo {
  readonly id: string;
  readonly title: LocalizedText;
  /** 페인 대신 확대 표면을 여는 엔트리라면 그 표면의 id — "패널 열기"가 이 값을 따른다. */
  readonly surfaceId?: string;
  /** 레일 엔트리가 등록한 아이콘. 팔레트의 「패널 열기」 행은 새 글리프를 그리지 않고 이것을 그대로 쓴다. */
  readonly icon?: ReactNode | (() => ReactNode);
}

/**
 * 명령 홈의 구역. 순서가 곧 홈의 순서다 — 최근 실행은 별도 구역으로 앞에 서고,
 * 그다음이 지금 보고 있는 Operation, 그 Operation이 사는 Theater, 화면, 패널, Console 순이다.
 */
export type PaletteCommandGroup = "current-operation" | "theater" | "view" | "panel" | "console";
export const PALETTE_COMMAND_GROUPS: readonly PaletteCommandGroup[] = ["current-operation", "theater", "view", "panel", "console"];

/**
 * 행 글리프 어휘. 모양이 종류를 말하고 색은 상태만 말한다 — 글리프는 한 잉크이고
 * 선택 행만 brass, 파괴 행만 coral이다. Theater 행은 사이드바 모노그램(`theater-monogram`),
 * 패널 행은 레일 엔트리의 등록 아이콘(`rail-entry`)을 쓰므로 여기서는 종류만 가린다.
 */
export type PaletteGlyphId =
  | "theater-monogram" | "theater-add" | "operation-new"
  | "operation-open" | "operation-resume" | "operation-close" | "operation-rename" | "operation-group" | "operation-accent" | "operation-minimize"
  | "view-minimize-all" | "view-fit" | "view-war-room" | "view-tactical" | "view-station-keeping" | "view-status-axis"
  | "rail-entry" | "console-sidebar" | "console-rail" | "console-band" | "console-theme" | "console-settings" | "console-shortcuts" | "console-whats-new" | "console-commissioning" | "console-undo";

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
  | { readonly kind: "open-rail-panel"; readonly panelId: string; readonly surfaceId?: string }
  | { readonly kind: "toggle-rail" }
  | { readonly kind: "toggle-sidebar" }
  | { readonly kind: "toggle-zen" }
  | { readonly kind: "toggle-command-band-dock" }
  | { readonly kind: "switch-theme"; readonly theme: ThemeId }
  | { readonly kind: "open-settings" }
  | { readonly kind: "open-keyboard-shortcuts" }
  | { readonly kind: "rename-operation"; readonly operationId: string }
  | { readonly kind: "assign-operation-group"; readonly operationId: string }
  | { readonly kind: "set-operation-accent"; readonly operationId: string }
  | { readonly kind: "minimize-operation"; readonly operationId: string }
  | { readonly kind: "whats-new" }
  | { readonly kind: "open-commissioning" };

export interface PaletteCommandEntry {
  readonly commandId: string;
  readonly label: string;
  readonly current: boolean;
  readonly action: PaletteCommandAction;
  readonly group: PaletteCommandGroup;
  readonly glyph: PaletteGlyphId;
  /**
   * 표시 언어와 다른 언어의 라벨. Fleet 어휘는 영어인데 한국어 UI의 라벨은 한글이 섞여
   * `>sidebar`가 0건이 되는 것을 막는다 — 매칭은 라벨과 별칭 중 나은 쪽을 취한다.
   */
  readonly aliases: readonly string[];
  /** 파괴 명령 — coral 잉크로 서고, 되돌릴 수 있으면 undoable도 함께 선다. */
  readonly danger?: boolean;
  readonly undoable?: boolean;
  /** 같은 일을 하는 전역 단축키(있을 때만). 행 오른쪽에 kbd로 선다. */
  /** 등록부 명령 id — 팔레트가 현재 조합을 그린다. */
  readonly shortcut?: string;
  /** 대상이 있는 명령의 대상 이름 — 현재 Operation 구역의 행 아래 캡션. */
  readonly subject?: string;
  /** 「모노그램」 글리프의 재료 — Theater 라벨. */
  readonly monogramSource?: string;
  /** 「레일 엔트리」 글리프의 재료 — 등록된 아이콘. */
  readonly railIcon?: ReactNode | (() => ReactNode);
}

export interface PaletteCommandSection {
  readonly id: "recent" | PaletteCommandGroup;
  readonly commands: readonly PaletteCommandEntry[];
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
  // 별칭은 표시 언어와 다른 쪽 라벨이다. 영어 UI에서는 한국어 라벨이 별칭이 되어 한글 입력도 맞는다.
  const alias = getT(language === "ko" ? "en" : "ko");
  const push = (
    entry: Omit<PaletteCommandEntry, "aliases" | "current"> & { readonly current?: boolean; readonly aliasLabel: string },
  ) => {
    const { aliasLabel, ...rest } = entry;
    commands.push({ ...rest, current: entry.current ?? false, aliases: aliasLabel === rest.label ? [] : [aliasLabel] });
  };
  const activeTheater = current.theaters.find((theater) => theater.id === current.activeTheaterId) ?? null;
  const activeOperation = current.operations.find(
    (operation) => operation.id === current.activeOperationId && operation.theaterId === current.activeTheaterId,
  ) ?? null;
  if (options?.canUndoLastClose === true) {
    push({ commandId: "undo-close", label: t("palette.undoClose"), aliasLabel: alias("palette.undoClose"), action: { kind: "undo-close" }, group: "console", glyph: "console-undo", shortcut: "console.undo-close" });
  }
  // 현재 Operation — 이 구역만이 Operation을 가리키는 명령을 가진다. 다른 Operation의 동작은
  // 검색 결과 행의 동작 띠가 맡는다(Operation마다 재개·닫기 쌍을 늘어놓던 옛 홈은 첫 화면을
  // 그 쌍으로 채웠다).
  if (activeOperation) {
    const subject = activeOperation.title;
    if (resolveOperationActivity(activeOperation, current.operationRuntime) === "ended") {
      push({ commandId: `resume-operation:${activeOperation.id}`, label: t("palette.resumeOperation", { title: subject }), aliasLabel: alias("palette.resumeOperation", { title: subject }), action: { kind: "resume-operation", operationId: activeOperation.id }, group: "current-operation", glyph: "operation-resume", subject });
    }
    push({ commandId: "rename-operation", label: t("palette.renameOperation"), aliasLabel: alias("palette.renameOperation"), action: { kind: "rename-operation", operationId: activeOperation.id }, group: "current-operation", glyph: "operation-rename", subject });
    push({ commandId: "assign-operation-group", label: t("palette.assignGroup"), aliasLabel: alias("palette.assignGroup"), action: { kind: "assign-operation-group", operationId: activeOperation.id }, group: "current-operation", glyph: "operation-group", subject });
    push({ commandId: "set-operation-accent", label: t("palette.setAccent"), aliasLabel: alias("palette.setAccent"), action: { kind: "set-operation-accent", operationId: activeOperation.id }, group: "current-operation", glyph: "operation-accent", subject });
    push({ commandId: "minimize-operation", label: t("palette.minimizeOperation"), aliasLabel: alias("palette.minimizeOperation"), action: { kind: "minimize-operation", operationId: activeOperation.id }, group: "current-operation", glyph: "operation-minimize", subject });
    push({ commandId: `close-operation:${activeOperation.id}`, label: t("palette.closeOperation", { title: subject }), aliasLabel: alias("palette.closeOperation", { title: subject }), action: { kind: "close-operation", operationId: activeOperation.id }, group: "current-operation", glyph: "operation-close", subject, danger: true, undoable: true });
  }
  for (const theater of current.theaters) {
    push({ commandId: `switch-theater:${theater.id}`, label: t("palette.switchTheater", { label: theater.label }), aliasLabel: alias("palette.switchTheater", { label: theater.label }), current: theater.id === current.activeTheaterId, action: { kind: "switch-theater", theaterId: theater.id }, group: "theater", glyph: "theater-monogram", monogramSource: theater.label });
  }
  push({ commandId: "new-theater", label: t("palette.newTheater"), aliasLabel: alias("palette.newTheater"), action: { kind: "new-theater" }, group: "theater", glyph: "theater-add" });
  if (activeTheater) {
    push({ commandId: "new-operation", label: t("palette.newOperation", { label: activeTheater.label }), aliasLabel: alias("palette.newOperation", { label: activeTheater.label }), action: { kind: "new-operation" }, group: "theater", glyph: "operation-new", shortcut: "console.quick-launch" });
    const theaterOperations = current.operations.filter((operation) => operation.theaterId === activeTheater.id);
    if (theaterOperations.length > 0) {
      push({ commandId: "minimize-all-operations", label: t("palette.minimizeAll"), aliasLabel: alias("palette.minimizeAll"), action: { kind: "minimize-all-operations" }, group: "view", glyph: "view-minimize-all" });
      push({ commandId: "fit-all-panels", label: t("palette.fitAllPanels"), aliasLabel: alias("palette.fitAllPanels"), action: { kind: "fit-all-panels" }, group: "view", glyph: "view-fit", shortcut: "operations.fit-all" });
    }
    push({ commandId: "toggle-triage-mode", label: t("palette.toggleTriage"), aliasLabel: alias("palette.toggleTriage"), action: { kind: "toggle-triage-mode" }, group: "view", glyph: "view-war-room", shortcut: "operations.toggle-triage" });
    push({ commandId: "toggle-formation", label: t("palette.toggleFormation"), aliasLabel: alias("palette.toggleFormation"), action: { kind: "toggle-formation" }, group: "view", glyph: "view-tactical", shortcut: "operations.toggle-formation" });
    push({ commandId: "toggle-station-keeping", label: t("palette.toggleStationKeeping"), aliasLabel: alias("palette.toggleStationKeeping"), action: { kind: "toggle-station-keeping" }, group: "view", glyph: "view-station-keeping" });
    push({ commandId: "toggle-status-axis", label: t("palette.toggleStatusAxis"), aliasLabel: alias("palette.toggleStatusAxis"), action: { kind: "toggle-status-axis" }, group: "view", glyph: "view-status-axis", shortcut: "operations.sort-by-status" });
  }
  for (const panel of railPanels) {
    // 설정은 아래에서 자기 이름의 일급 명령(open-settings)으로 선다 — 같은 표면을 여는
    // "Open panel: Settings"까지 만들면 팔레트에 같은 문이 두 개 선다.
    if (panel.id === "settings") continue;
    const title = resolveLocalizedText(panel.title, language);
    push({
      commandId: `open-rail-panel:${panel.id}`,
      label: t("palette.openPanel", { title }),
      aliasLabel: alias("palette.openPanel", { title: resolveLocalizedText(panel.title, language === "ko" ? "en" : "ko") }),
      action: { kind: "open-rail-panel", panelId: panel.id, ...(panel.surfaceId === undefined ? {} : { surfaceId: panel.surfaceId }) },
      group: "panel",
      glyph: "rail-entry",
      shortcut: CORE_SHORTCUT_COMMANDS.find((command) => command.railEntryId === panel.id)?.id,
      ...(panel.icon === undefined ? {} : { railIcon: panel.icon }),
    });
  }
  push({ commandId: "toggle-sidebar", label: t("palette.toggleSidebar"), aliasLabel: alias("palette.toggleSidebar"), action: { kind: "toggle-sidebar" }, group: "console", glyph: "console-sidebar", shortcut: "console.toggle-sidebar" });
  push({ commandId: "toggle-rail", label: t("palette.toggleRail"), aliasLabel: alias("palette.toggleRail"), action: { kind: "toggle-rail" }, group: "console", glyph: "console-rail", shortcut: "console.toggle-rail" });
  // 전체화면에서 밴드가 숨은 동안 그 안의 토글은 inert라 닿지 않는다 — 팔레트가 표면 밖 경로다.
  // 라벨은 저장된 선호를 따른다: 이 항목은 전환이므로 한 방향으로만 읽히면 이미 켜 둔 사용자가
  // 켜는 줄 알고 골랐다가 밴드를 끄게 된다. current는 false로 둔다 — 전환 항목은 배지 대상이 아니고,
  // true면 팔레트가 이미 적용된 선택으로 보아 실행을 건너뛴다.
  const zenKey = isZenMode() ? "zen.exit" : "zen.enter";
  push({ commandId: "toggle-zen", label: t(zenKey), aliasLabel: `${alias(zenKey)} 집중 크롬`, action: { kind: "toggle-zen" }, group: "view", glyph: "console-band", shortcut: "console.toggle-zen" });
  const bandKey = getCommandBandDocked() ? "palette.stopKeepingCommandBandVisible" : "palette.keepCommandBandVisible";
  push({ commandId: "toggle-command-band-dock", label: t(bandKey), aliasLabel: alias(bandKey), action: { kind: "toggle-command-band-dock" }, group: "console", glyph: "console-band" });
  for (const theme of buildPaletteThemes(t)) {
    push({ commandId: `switch-theme:${theme.id}`, label: t("palette.switchTheme", { label: theme.label }), aliasLabel: alias("palette.switchTheme", { label: theme.label }), current: theme.id === current.activeTheme, action: { kind: "switch-theme", theme: theme.id }, group: "console", glyph: "console-theme" });
  }
  push({ commandId: "open-settings", label: t("palette.openSettings"), aliasLabel: alias("palette.openSettings"), action: { kind: "open-settings" }, group: "console", glyph: "console-settings" });
  push({ commandId: "open-keyboard-shortcuts", label: t("palette.openKeyboardShortcuts"), aliasLabel: alias("palette.openKeyboardShortcuts"), action: { kind: "open-keyboard-shortcuts" }, group: "console", glyph: "console-shortcuts" });
  // 취역 가이드는 첫 부팅에 한 번 뜨고 닫히면 사라진다 — 팔레트가 그 뒤의 유일한 재진입로다.
  push({ commandId: "open-commissioning", label: t("palette.openCommissioning"), aliasLabel: alias("palette.openCommissioning"), action: { kind: "open-commissioning" }, group: "console", glyph: "console-commissioning" });
  if (current.releaseNotes.length > 0) {
    push({ commandId: "whats-new", label: t("palette.whatsNew"), aliasLabel: alias("palette.whatsNew"), action: { kind: "whats-new" }, group: "console", glyph: "console-whats-new" });
  }
  return commands;
}

/**
 * 빈 명령 입력의 홈. 최근 실행이 있으면 그 구역이 먼저 서고, 나머지는 구역 순서대로다.
 * 최근에 든 명령도 자기 구역에 다시 선다 — 홈은 색인이지 중복 제거 목록이 아니다.
 */
export function groupPaletteCommands(
  commands: readonly PaletteCommandEntry[],
  recentCommandIds: readonly string[],
): readonly PaletteCommandSection[] {
  const sections: PaletteCommandSection[] = [];
  const recent = recentCommandIds
    .map((id) => commands.find((command) => command.commandId === id))
    .filter((command): command is PaletteCommandEntry => command !== undefined);
  if (recent.length > 0) sections.push({ id: "recent", commands: recent });
  for (const group of PALETTE_COMMAND_GROUPS) {
    const members = commands.filter((command) => command.group === group);
    if (members.length > 0) sections.push({ id: group, commands: members });
  }
  return sections;
}

export function matchPaletteCommands(
  commands: readonly PaletteCommandEntry[],
  query: string,
): readonly ScoredPaletteCommand[] {
  if (searchTokens(query).length === 0) {
    return commands.map((command) => ({ command, score: 0, exactTokens: 0, matchedIndices: [] }));
  }
  return commands.flatMap((command, originalIndex) => {
    const match = bestPaletteMatch(command, query);
    return match ? [{ command, ...match, originalIndex }] : [];
  }).sort((left, right) =>
    right.exactTokens - left.exactTokens
    || right.score - left.score
    || left.originalIndex - right.originalIndex)
    .map(({ command, score, exactTokens, matchedIndices }) => ({ command, score, exactTokens, matchedIndices }));
}


/** 라벨과 별칭 중 가장 잘 맞는 쪽. 하이라이트 인덱스는 라벨에 맞은 경우에만 의미가 있다. */
export function bestPaletteMatch(command: PaletteCommandEntry, query: string): PaletteCommandMatch | null {
  let best = fuzzyMatchPaletteLabel(command.label, query);
  for (const aliasLabel of command.aliases) {
    const candidate = fuzzyMatchPaletteLabel(aliasLabel, query);
    if (!candidate) continue;
    if (!best || candidate.exactTokens > best.exactTokens || (candidate.exactTokens === best.exactTokens && candidate.score > best.score)) {
      best = { ...candidate, matchedIndices: [] };
    }
  }
  return best;
}

export function filterPaletteCommands(commands: readonly PaletteCommandEntry[], query: string): readonly PaletteCommandEntry[] {
  if (searchTokens(query).length === 0) return commands;
  return matchPaletteCommands(commands, query).map(({ command }) => command);
}

function resolveActiveLocale() {
  const preference = getGlobalSettingsStoreState().state?.language ?? "auto";
  const navigatorLanguage =
    typeof navigator !== "undefined" && typeof navigator.language === "string"
      ? navigator.language.toLowerCase()
      : "";
  return resolveConsoleLanguage(preference, navigatorLanguage);
}
