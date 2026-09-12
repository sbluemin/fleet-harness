// Console 단축키 등록부 — 명령 하나에 조합 하나(또는 둘)를 잇는 단일 출처.
// 발화(global-shortcuts.ts, pages/operations.tsx)와 표시(도움말·팔레트·접힘 힌트·Quick Launch 띠)가
// 모두 여기서 읽는다. 예전에는 같은 조합이 여섯 곳에 리터럴로 적혀 있어 사용자가 바꿀 자리가 없었고,
// 도움말은 「⌘/Ctrl」로, 팔레트는 「⌘」로 그려 표기마저 갈렸다.
//
// 조합 문자열 문법: `Mod+Alt+KeyB`처럼 수식키(Mod·Ctrl·Alt·Shift, 이 순서)와 물리 키 코드(event.code)를
// `+`로 잇는다. 물리 코드로 저장하는 이유는 macOS의 Option+문자가 합성문자를 내보내기 때문이다 —
// 레이아웃이 달라도 같은 자리의 키가 같은 명령을 낸다.

import { useSyncExternalStore } from "react";

import type { CoreMessageKey } from "./i18n/index.js";

export type ShortcutBindings = Readonly<Record<string, readonly string[]>>;

export type ShortcutCommandGroup = "console" | "operations" | "companion";

export interface ShortcutCommand {
  readonly id: string;
  readonly group: ShortcutCommandGroup;
  readonly descriptionKey: CoreMessageKey;
  readonly defaults: readonly string[];
}

export const CORE_SHORTCUT_COMMANDS: readonly ShortcutCommand[] = [
  { id: "console.search-operations", group: "console", descriptionKey: "shortcuts.console.searchOps", defaults: ["Mod+KeyK"] },
  { id: "console.command-palette", group: "console", descriptionKey: "shortcuts.console.commandPalette", defaults: ["Mod+KeyP"] },
  { id: "console.quick-launch", group: "console", descriptionKey: "shortcuts.console.quickLaunch", defaults: ["Mod+KeyJ", "Ctrl+Space"] },
  { id: "console.toggle-sidebar", group: "console", descriptionKey: "shortcuts.console.toggleSidebar", defaults: ["Mod+KeyB"] },
  { id: "console.toggle-rail", group: "console", descriptionKey: "shortcuts.console.toggleRail", defaults: ["Mod+Alt+KeyB"] },
  { id: "console.undo-close", group: "console", descriptionKey: "shortcuts.operations.undoClose", defaults: ["Mod+KeyZ"] },
  { id: "operations.sort-by-status", group: "operations", descriptionKey: "shortcuts.map.sortByStatus", defaults: ["Alt+KeyS"] },
  { id: "operations.toggle-formation", group: "operations", descriptionKey: "shortcuts.map.toggleFormation", defaults: ["Alt+KeyF"] },
  { id: "operations.toggle-triage", group: "operations", descriptionKey: "shortcuts.map.toggleTriage", defaults: ["Alt+KeyT"] },
  { id: "operations.fit-all", group: "operations", descriptionKey: "shortcuts.map.fitAll", defaults: ["Shift+Digit1"] },
];

const CORE_COMMANDS_BY_ID = new Map(CORE_SHORTCUT_COMMANDS.map((command) => [command.id, command]));

/** 플러그인 companion 패널의 명령 id — 플러그인과 패널 id가 함께 자리를 정한다. */
export function companionShortcutCommandId(pluginId: string, companionId: string): string {
  return `companion:${pluginId}:${companionId}`;
}

export function companionDefaultChord(code: string): string {
  return `Alt+${code}`;
}

// ─── 저장값(사용자 재배정) 스토어 ─────────────────────────────────────────────

const listeners = new Set<() => void>();
let overrides: ShortcutBindings = {};

export function getShortcutOverrides(): ShortcutBindings {
  return overrides;
}

export function setShortcutOverrides(next: ShortcutBindings): void {
  overrides = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 조합이 바뀌면 다시 그려야 하는 표시 표면이 구독한다. */
export function useShortcutOverrides(): ShortcutBindings {
  return useSyncExternalStore(subscribe, getShortcutOverrides, getShortcutOverrides);
}

export function resolveShortcutChords(commandId: string, defaults?: readonly string[]): readonly string[] {
  const fallback = defaults ?? CORE_COMMANDS_BY_ID.get(commandId)?.defaults ?? [];
  const custom = overrides[commandId];
  return custom !== undefined && custom.length === fallback.length ? custom : fallback;
}

/**
 * 기본값과 같은 항목은 저장하지 않는다 — 저장값은 「사용자가 바꾼 것」만 담아야 기본값이 바뀌는
 * 릴리스에서 바꾸지 않은 사람이 새 기본값을 받는다.
 */
export function withShortcutOverride(current: ShortcutBindings, commandId: string, chords: readonly string[], defaults: readonly string[]): ShortcutBindings {
  const { [commandId]: _dropped, ...rest } = current;
  return chords.length === defaults.length && chords.every((chord, index) => chord === defaults[index])
    ? rest
    : { ...rest, [commandId]: chords };
}

// ─── 기록 중 가드 ──────────────────────────────────────────────────────────────

const RECORDING_ATTRIBUTE = "data-shortcut-recording";

/**
 * 설정 카드가 키를 받는 동안 전역 핸들러는 물러선다. 같은 window 캡처 리스너라 등록 순서로는
 * 전역 쪽이 먼저 받으므로, 순서가 아니라 이 표식으로 양보한다.
 */
export function setShortcutRecording(recording: boolean, documentFor: Document = document): void {
  if (recording) documentFor.body.setAttribute(RECORDING_ATTRIBUTE, "true");
  else documentFor.body.removeAttribute(RECORDING_ATTRIBUTE);
}

export function isShortcutRecording(documentFor: Document = document): boolean {
  return documentFor.body.getAttribute(RECORDING_ATTRIBUTE) === "true";
}

// ─── 조합 문법 ─────────────────────────────────────────────────────────────────

export const CHORD_MODIFIERS = ["Mod", "Ctrl", "Alt", "Shift"] as const;
export type ChordModifier = (typeof CHORD_MODIFIERS)[number];

// 키 자리에는 `KeyboardEvent.code` 전 범위가 온다 — 플러그인이 SDK로 선언한 companion 코드(Numpad1 등)도
// 같은 공간이라 화이트리스트를 두면 그 기본값이 조용히 죽는다. 수식키 자체와 Escape·Tab만 제외한다.
export const CHORD_KEY_CODE = /^(?!(?:Shift|Control|Alt|Meta)(?:Left|Right)$|CapsLock$|Escape$|Tab$)[A-Za-z0-9]{1,32}$/u;

/** 재배정 밖의 고정 문법(Alt+화살표 넷) — 기록기가 이 조합을 받으면 그 문법이 가려진다. */
export const RESERVED_CHORDS: readonly string[] = ["Alt+ArrowLeft", "Alt+ArrowRight", "Alt+ArrowUp", "Alt+ArrowDown"];

export interface ParsedChord {
  readonly modifiers: ReadonlySet<ChordModifier>;
  readonly code: string;
}

export function parseChord(chord: string): ParsedChord | null {
  const tokens = chord.split("+");
  const code = tokens.pop();
  if (!code || !CHORD_KEY_CODE.test(code)) return null;
  const modifiers = new Set<ChordModifier>();
  for (const token of tokens) {
    if (!(CHORD_MODIFIERS as readonly string[]).includes(token) || modifiers.has(token as ChordModifier)) return null;
    modifiers.add(token as ChordModifier);
  }
  return { modifiers, code };
}

export function serializeChord(modifiers: Iterable<ChordModifier>, code: string): string {
  const set = new Set(modifiers);
  return [...CHORD_MODIFIERS.filter((modifier) => set.has(modifier)), code].join("+");
}

export function isApplePlatform(navigatorFor: Navigator = navigator): boolean {
  const userAgentDataPlatform = (navigatorFor as Navigator & { readonly userAgentData?: { readonly platform?: string } }).userAgentData?.platform;
  const platform = userAgentDataPlatform ?? navigatorFor.platform;
  return /mac|iphone|ipad|ipod/i.test(platform);
}

interface ChordEventLike {
  readonly code: string;
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * 눌린 키를 조합으로 읽는다. 수식키만 눌렸으면 null.
 * Mod는 macOS에서 ⌘, 그 밖에서 Ctrl이다. macOS의 ⌃은 별도 수식키(Ctrl)로 남고, 다른 OS에서는
 * Ctrl이 곧 Mod라 두 이름이 한 키를 가리킨다 — 그래서 저장값 `Ctrl+Space`는 Windows에서 Ctrl+Space,
 * macOS에서 ⌃Space로 같은 물리 동작을 낸다. Win/Super 키는 OS 것이라 조합에 넣지 않는다.
 */
export function chordFromKeyboardEvent(event: ChordEventLike, apple: boolean = isApplePlatform()): string | null {
  if (!CHORD_KEY_CODE.test(event.code)) return null;
  const modifiers = new Set<ChordModifier>();
  if (apple) {
    if (event.metaKey) modifiers.add("Mod");
    if (event.ctrlKey) modifiers.add("Ctrl");
  } else {
    if (event.metaKey) return null;
    if (event.ctrlKey) modifiers.add("Mod");
  }
  if (event.altKey) modifiers.add("Alt");
  if (event.shiftKey) modifiers.add("Shift");
  return serializeChord(modifiers, event.code);
}

/**
 * 이벤트가 조합과 정확히 맞는가. 수식키는 남거나 모자라면 안 된다 — 사용자가 Mod+Shift+K를 다른
 * 명령에 배정할 수 있어야 하므로 「Shift는 허용」 같은 느슨함을 두지 않는다.
 *
 * Win/Linux의 Ctrl+Alt는 일부 레이아웃에서 AltGr(문자 입력)와 같게 보고되고 Firefox/Windows는 진성
 * Ctrl+Alt에도 AltGraph=true를 주므로, Mod와 Alt를 함께 쥔 조합은 「이 키가 실제로 그 문자를 냈는가」
 * (event.key)로 한 번 더 가른다. macOS는 ⌘로 발화하므로 이 판정이 필요 없다.
 */
export function matchesChord(event: ChordEventLike, chord: string, apple: boolean = isApplePlatform()): boolean {
  const parsed = parseChord(chord);
  if (parsed === null || event.code !== parsed.code) return false;
  const wantsMod = parsed.modifiers.has("Mod");
  const wantsCtrl = parsed.modifiers.has("Ctrl");
  if (apple) {
    if (event.metaKey !== wantsMod || event.ctrlKey !== wantsCtrl) return false;
  } else {
    if (event.metaKey) return false;
    if (event.ctrlKey !== (wantsMod || wantsCtrl)) return false;
  }
  if (event.altKey !== parsed.modifiers.has("Alt") || event.shiftKey !== parsed.modifiers.has("Shift")) return false;
  if (!apple && (wantsMod || wantsCtrl) && parsed.modifiers.has("Alt") && parsed.code.startsWith("Key")) {
    return event.key.toLowerCase() === parsed.code.slice(3).toLowerCase();
  }
  return true;
}

/**
 * 두 조합이 같은 물리 동작인가. macOS 밖에서는 Ctrl이 곧 Mod라 `Ctrl+Space`와 `Mod+Space`가 한 키다 —
 * 문자열이 달라도 겹침으로 봐야 나중에 배정한 명령이 앞선 분기에 가려지는 일이 없다.
 */
export function chordsEquivalent(a: string, b: string, apple: boolean = isApplePlatform()): boolean {
  if (a === b) return true;
  if (apple) return false;
  const fold = (chord: string) => {
    const parsed = parseChord(chord);
    if (parsed === null) return chord;
    const modifiers = new Set(parsed.modifiers);
    if (modifiers.delete("Ctrl")) modifiers.add("Mod");
    return serializeChord(modifiers, parsed.code);
  };
  return fold(a) === fold(b);
}

export function matchesShortcutCommand(event: ChordEventLike, commandId: string, apple: boolean = isApplePlatform()): boolean {
  return resolveShortcutChords(commandId).some((chord) => matchesChord(event, chord, apple));
}

// ─── 표기 ─────────────────────────────────────────────────────────────────────

const CODE_LABELS: Readonly<Record<string, string>> = {
  Space: "Space",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Backquote: "`",
};

export function keyCodeLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return CODE_LABELS[code] ?? code;
}

/** 조합을 글쇠 라벨 목록으로. 도움말·팔레트의 <kbd>가 하나씩 받는다. */
export function chordKeyLabels(chord: string, apple: boolean = isApplePlatform()): readonly string[] {
  const parsed = parseChord(chord);
  if (parsed === null) return [chord];
  const labels: string[] = [];
  for (const modifier of CHORD_MODIFIERS) {
    if (!parsed.modifiers.has(modifier)) continue;
    labels.push(
      modifier === "Mod" ? (apple ? "⌘" : "Ctrl")
        : modifier === "Ctrl" ? (apple ? "⌃" : "Ctrl")
          : modifier === "Alt" ? (apple ? "⌥" : "Alt")
            : (apple ? "⇧" : "Shift"),
    );
  }
  labels.push(keyCodeLabel(parsed.code));
  return labels;
}

/**
 * 한 덩어리로 읽는 힌트 표기. macOS 기호 조합은 붙여 쓰고(⌘⌥B), 글자 이름이 섞이면 +로 잇는다
 * (Ctrl+Alt+B, ⌃Space가 아니라 ⌃+Space는 아니다 — 기호끼리는 붙인다).
 */
export function chordLabel(chord: string, apple: boolean = isApplePlatform()): string {
  const labels = chordKeyLabels(chord, apple);
  const symbolic = labels.every((label) => /^[⌘⌃⌥⇧]$/u.test(label) || label.length === 1 || /^[↑↓←→]$/u.test(label));
  return labels.join(symbolic ? "" : "+");
}

export function shortcutCommandLabel(commandId: string, apple: boolean = isApplePlatform()): string {
  const [first] = resolveShortcutChords(commandId);
  return first === undefined ? "" : chordLabel(first, apple);
}

// ─── 기록 검증 ────────────────────────────────────────────────────────────────

export type RecordedChordVerdict =
  | { readonly kind: "ok"; readonly chord: string; readonly warning: "ime" | "spotlight" | null }
  | { readonly kind: "reject"; readonly reason: "no-modifier" | "blocked" | "reserved" };

/**
 * 기록된 조합을 받아들일지 정한다. 수식키(Mod·Ctrl·Alt) 없는 조합은 타자를 삼키므로 거부한다 —
 * Shift만 쥔 조합은 문자 키가 아닐 때(Shift+1처럼)만 받는다. ⌘Q·⌘W(·macOS의 ⌘H)는 창을 닫는
 * OS 키라 막고, Ctrl+Space(입력 소스 전환)와 ⌘Space(Spotlight)는 경고만 하고 받는다 —
 * 전자는 지금의 기본값이기도 하다.
 */
export function judgeRecordedChord(chord: string, apple: boolean = isApplePlatform()): RecordedChordVerdict {
  const parsed = parseChord(chord);
  if (parsed === null) return { kind: "reject", reason: "no-modifier" };
  const strong = parsed.modifiers.has("Mod") || parsed.modifiers.has("Ctrl") || parsed.modifiers.has("Alt");
  if (!strong && (!parsed.modifiers.has("Shift") || parsed.code.startsWith("Key"))) return { kind: "reject", reason: "no-modifier" };
  if (parsed.modifiers.size === 1 && parsed.modifiers.has("Mod") && (parsed.code === "KeyQ" || parsed.code === "KeyW" || (apple && parsed.code === "KeyH"))) {
    return { kind: "reject", reason: "blocked" };
  }
  if (RESERVED_CHORDS.some((reserved) => chordsEquivalent(reserved, chord, apple))) return { kind: "reject", reason: "reserved" };
  const soleCtrl = parsed.modifiers.size === 1 && parsed.modifiers.has("Ctrl");
  const soleMod = parsed.modifiers.size === 1 && parsed.modifiers.has("Mod");
  if (parsed.code === "Space" && (soleCtrl || (!apple && soleMod))) return { kind: "ok", chord, warning: "ime" };
  if (parsed.code === "Space" && apple && soleMod) return { kind: "ok", chord, warning: "spotlight" };
  return { kind: "ok", chord, warning: null };
}
