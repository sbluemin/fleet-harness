// Console keyboard-shortcut policy: the dialog catalog, companion shortcut admission,
// and the guards every global key handler consults first.
// Installation of the window-level listeners stays in global-shortcuts.ts, which reads
// the dialog module — folding it in here would make the two files import each other.

import type { CompanionPanelDescriptor } from "@fleet-console/sdk/plugin";
import type { CoreMessageKey } from "../i18n/index.js";
import type { Translate } from "@fleet-console/sdk/i18n";

import { chordKeyLabels, isApplePlatform, resolveShortcutChords, shortcutCommandLabel, useShortcutOverrides } from "./shortcut-bindings.js";

// ─── catalog — entries, groups, and combo formatting ───────────────────────────

export interface ShortcutEntry {
  readonly combos: readonly (readonly string[])[];
  readonly description: string;
}

export interface ShortcutGroup {
  readonly title: string;
  readonly entries: readonly ShortcutEntry[];
}

type T = Translate<CoreMessageKey>;

/**
 * 도움말 목록. 재배정 가능한 명령은 등록부(현재 조합)를 읽고, 문법 묶음(Alt+화살표)과 제스처는
 * 글쇠 라벨 리터럴로 남는다. 조합 라벨은 플랫폼으로 푼다(⌘ 또는 Ctrl) — 팔레트·접힘 힌트와 같은 표기.
 */
export function buildShortcutGroups(t: T): readonly ShortcutGroup[] {
  const alt = isApplePlatform() ? "⌥" : "Alt";
  const shift = isApplePlatform() ? "⇧" : "Shift";
  const bound = (commandId: string, defaults?: readonly string[]) => resolveShortcutChords(commandId, defaults).map((chord) => chordKeyLabels(chord));
  return [
    {
      title: t("shortcuts.group.console"),
      entries: [
        { combos: bound("console.search-operations"), description: t("shortcuts.console.searchOps") },
        { combos: bound("console.command-palette"), description: t("shortcuts.console.commandPalette") },
        { combos: bound("console.new-session"), description: t("shortcuts.console.newSession") },
        { combos: bound("console.toggle-global-shell"), description: t("shortcuts.console.toggleGlobalShell") },
        { combos: bound("console.toggle-repository"), description: t("shortcuts.console.toggleRepository") },
        { combos: bound("console.toggle-objectives"), description: t("shortcuts.console.toggleObjectives") },
      ],
    },
    {
      title: t("shortcuts.group.operations"),
      entries: [
        { combos: bound("console.undo-close"), description: t("shortcuts.operations.undoClose") },
        { combos: [[shift, "Enter"]], description: t("shortcuts.operations.insertNewline") },
        { combos: [["Enter"], ["Esc"]], description: t("shortcuts.operations.renameConfirm") },
        { combos: [["↑"], ["↓"]], description: t("shortcuts.operations.menuNav") },
      ],
    },
    {
      title: t("shortcuts.group.map"),
      entries: [
        { combos: [[alt, "←"], [alt, "→"]], description: t("shortcuts.map.focusPrevNext") },
        { combos: bound("operations.sort-by-status"), description: t("shortcuts.map.sortByStatus") },
        { combos: [["Right-click"]], description: t("shortcuts.map.contextMenu") },
      ],
    },
  ];
}

// ─── companion shortcut admission ─────────────────────────────────────────────

// core가 플러그인보다 먼저 소비하는 키는 선언을 허용하면 도움말과 실제 디스패치가 어긋난다.
export const RESERVED_SHORTCUT_CODES: readonly string[] = [
  "KeyS", "ArrowLeft", "ArrowRight", "Escape",
];

export function usableCompanionShortcuts(
  companions: readonly CompanionPanelDescriptor[],
  extraReservedCodes: readonly string[] = [],
): readonly CompanionPanelDescriptor[] {
  const seenCodes = new Set<string>();
  return companions.filter((companion) => {
    const code = companion.shortcut?.code;
    if (!code || RESERVED_SHORTCUT_CODES.includes(code) || extraReservedCodes.includes(code) || seenCodes.has(code)) return false;
    seenCodes.add(code);
    return true;
  });
}

// ─── focus guards — dialog boundary and return-focus handoff ───────────────────

// Console-wide keyboard commands must consult this boundary before acting. Dialogs
// can be rendered through portals, so event listener ordering is not a safe guard.
export function isBlockingDialogOpen(documentFor: Document = document): boolean {
  return documentFor.querySelector('[aria-modal="true"]:not([hidden])') !== null;
}

// 팔레트처럼 "자신이 닫히면서" 단축키 다이얼로그를 여는 표면이, 다이얼로그가 닫힐 때 복원할
// 원래 포커스 요소를 App에 넘기는 1회성 채널. 여는 시점의 document.activeElement는 이미
// 제거 중인 표면 내부 요소라 App 캡처만으로는 opener를 알 수 없다.
// (core 클라이언트 단일 번들 내부 전용 — 호스트/플러그인 번들 경계를 넘지 않는다.)
let target: HTMLElement | null = null;

export function stashKeyboardShortcutsReturnFocus(element: HTMLElement | null): void {
  target = element;
}

export function takeKeyboardShortcutsReturnFocus(): HTMLElement | null {
  const taken = target;
  target = null;
  return taken;
}

// 취역 가이드도 같은 사정이다 — 팔레트가 닫히며 열면 오버레이의 passive effect가 보는 activeElement는
// 이미 body라, 닫힐 때 원래 컨트롤로 돌아갈 수 없다. 여는 쪽이 opener를 이 채널로 넘긴다.
let commissioningTarget: HTMLElement | null = null;

export function stashCommissioningReturnFocus(element: HTMLElement | null): void {
  commissioningTarget = element;
}

export function takeCommissioningReturnFocus(): HTMLElement | null {
  const taken = commissioningTarget;
  commissioningTarget = null;
  return taken;
}

// ⌘K / Ctrl+K — 검색 팔레트 단축키 표기. 첫 실행 시작 블록처럼 팔레트 밖에서 그 단축키를 말하는 자리가 쓴다.
export function useSearchShortcutLabel(): string {
  useShortcutOverrides();
  return shortcutCommandLabel("console.search-operations");
}

export function useNewSessionShortcutLabel(): string {
  useShortcutOverrides();
  return shortcutCommandLabel("console.new-session");
}

// ─── editing guard — when typing swallows an Operations shortcut ───────────────

/**
 * 편집 중인 요소에 포커스가 있을 때 Operations 단축키를 삼킬지 정하는 정책.
 *
 * 기본은 삼키는 것이다 — 타자가 단축키에 먹히면 글을 쓸 수 없다. 예외는 Alt를 쥔 조합 전체,
 * 즉 Console 뷰 축(Alt+문자)과 패널 축(Alt+화살표)이다: 같은 키가 터미널 포커스에서는 이미
 * 살아 있으므로(xterm은 편집 판정에서 빠진다), 컴포저에 포커스가 있다는 이유로만 화면을 바꾸는
 * 키가 죽으면 표면마다 문법이 갈린다. macOS의 Option+문자 합성은 각 분기의 preventDefault가
 * 막으므로 문자가 새지 않는다.
 *
 * 화살표에도 예외를 두지 않는다. 채팅 패널에서 캐럿이 사는 자리는 컴포저 하나뿐이라, 편집 중
 * Alt+화살표를 캐럿 이동에 내주면 패널 사이를 오가는 키가 정확히 필요한 순간에만 죽는다.
 * macOS의 단어 단위 이동은 같은 사정을 이미 터미널에서 Console에 내주고 있고, 선택(Alt+Shift+
 * 화살표)은 shiftKey 분기가 preventDefault 없이 통과시키므로 편집자에게 그대로 남는다.
 */
export function blocksOperationsShortcutWhileEditing(
  editing: boolean,
  event: { readonly altKey: boolean },
): boolean {
  return editing && !event.altKey;
}

// ─── arrow keys — Operations focus ─────────────────────────────────────────────

export type OperationsArrowShortcutAction = "focus-previous" | "focus-next";

export function resolveOperationsArrowShortcutAction(key: string): OperationsArrowShortcutAction | null {
  if (key === "ArrowRight") return "focus-next";
  if (key === "ArrowLeft") return "focus-previous";
  return null;
}
