/**
 * 단축키 재배정 저장값 — 코어 general 설정의 한 항목이지만 문법은 SDK가 소유한다.
 * 서버(저장 전 검증)와 브라우저(기록·발화)가 같은 규칙으로 읽어야 「눌러서 등록한 키가 서버에서
 * 버려지는」 어긋남이 없다.
 *
 * 형태: 명령 id → 조합 문자열 목록. 조합은 `Mod+Alt+KeyB`처럼 수식키(Mod·Ctrl·Alt·Shift, 이 순서)와
 * 물리 키 코드(KeyboardEvent.code)를 `+`로 잇는다. 기본값과 같은 명령은 담지 않는다.
 */

export type ShortcutBindings = Readonly<Record<string, readonly string[]>>;

/** 수식키는 최소 하나 — 수식키 없는 문자는 타자를 삼키므로 저장 문법에서부터 막는다. */
export const SHORTCUT_CHORD_PATTERN = /^(?=(?:Mod|Ctrl|Alt|Shift)\+)(?:Mod\+)?(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2])|Space|Arrow(?:Up|Down|Left|Right)|Minus|Equal|BracketLeft|BracketRight|Semicolon|Quote|Comma|Period|Slash|Backslash|Backquote)$/u;

const SHORTCUT_COMMAND_ID_PATTERN = /^[a-z][a-z0-9.-]{0,63}(?::[A-Za-z0-9_.-]{1,64}){0,2}$/u;

/** 한 명령이 가질 수 있는 조합 수 — Quick Launch처럼 대안 조합이 하나 더 있는 경우까지. */
export const SHORTCUT_CHORDS_PER_COMMAND_MAX = 2;
const SHORTCUT_COMMANDS_MAX = 64;

export function isShortcutChord(value: unknown): value is string {
  return typeof value === "string" && SHORTCUT_CHORD_PATTERN.test(value);
}

/** 저장 요청 본문이 통째로 유효한가 — 한 항목이라도 어긋나면 400이다. */
export function isShortcutBindingsInput(value: unknown): value is ShortcutBindings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > SHORTCUT_COMMANDS_MAX) return false;
  return entries.every(([commandId, chords]) => SHORTCUT_COMMAND_ID_PATTERN.test(commandId)
    && Array.isArray(chords) && chords.length >= 1 && chords.length <= SHORTCUT_CHORDS_PER_COMMAND_MAX
    && chords.every(isShortcutChord) && new Set(chords).size === chords.length);
}

/** 저장된 값을 읽을 때는 관대하다 — 어긋난 항목만 버리고 나머지는 살린다. */
export function sanitizeShortcutBindings(value: unknown): ShortcutBindings | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const result: Record<string, readonly string[]> = {};
  for (const [commandId, chords] of Object.entries(value as Record<string, unknown>).slice(0, SHORTCUT_COMMANDS_MAX)) {
    if (!SHORTCUT_COMMAND_ID_PATTERN.test(commandId) || !Array.isArray(chords)) continue;
    const valid = [...new Set(chords.filter(isShortcutChord))].slice(0, SHORTCUT_CHORDS_PER_COMMAND_MAX);
    if (valid.length > 0) result[commandId] = valid;
  }
  return result;
}
