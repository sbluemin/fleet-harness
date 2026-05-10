// core-shell — 키 입력 인코딩
// TUI 키 이름을 PTY 입력 시퀀스로 변환합니다.

/** 이름이 붙은 기본 키 시퀀스 */
const NAMED_KEYS: Record<string, string> = {
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  enter: "\r",
  return: "\r",
  escape: "\x1b",
  esc: "\x1b",
  tab: "\t",
  space: " ",
  backspace: "\x7f",
  bspace: "\x7f",
  delete: "\x1b[3~",
  del: "\x1b[3~",
  dc: "\x1b[3~",
  insert: "\x1b[2~",
  ic: "\x1b[2~",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pgup: "\x1b[5~",
  ppage: "\x1b[5~",
  pagedown: "\x1b[6~",
  pgdn: "\x1b[6~",
  npage: "\x1b[6~",
  btab: "\x1b[Z",
  f1: "\x1bOP",
  f2: "\x1bOQ",
  f3: "\x1bOR",
  f4: "\x1bOS",
  f5: "\x1b[15~",
  f6: "\x1b[17~",
  f7: "\x1b[18~",
  f8: "\x1b[19~",
  f9: "\x1b[20~",
  f10: "\x1b[21~",
  f11: "\x1b[23~",
  f12: "\x1b[24~",
  kp0: "\x1bOp",
  kp1: "\x1bOq",
  kp2: "\x1bOr",
  kp3: "\x1bOs",
  kp4: "\x1bOt",
  kp5: "\x1bOu",
  kp6: "\x1bOv",
  kp7: "\x1bOw",
  kp8: "\x1bOx",
  kp9: "\x1bOy",
  "kp/": "\x1bOo",
  "kp*": "\x1bOj",
  "kp-": "\x1bOm",
  "kp+": "\x1bOk",
  "kp.": "\x1bOn",
  kpenter: "\x1bOM",
};

/** Ctrl 조합 */
const CTRL_KEYS: Record<string, string> = {};

const MODIFIABLE_KEYS = new Set([
  "up", "down", "left", "right", "home", "end",
  "pageup", "pgup", "ppage", "pagedown", "pgdn", "npage",
  "insert", "ic", "delete", "del", "dc",
]);

for (let i = 0; i < 26; i++) {
  const char = String.fromCharCode(97 + i);
  CTRL_KEYS[`ctrl+${char}`] = String.fromCharCode(i + 1);
}
CTRL_KEYS["ctrl+["] = "\x1b";
CTRL_KEYS["ctrl+\\"] = "\x1c";
CTRL_KEYS["ctrl+]"] = "\x1d";
CTRL_KEYS["ctrl+^"] = "\x1e";
CTRL_KEYS["ctrl+_"] = "\x1f";
CTRL_KEYS["ctrl+?"] = "\x7f";

export function encodeKeyToken(token: string): string {
  const normalized = token.trim().toLowerCase();
  if (!normalized) return "";

  if (NAMED_KEYS[normalized]) return NAMED_KEYS[normalized];
  if (CTRL_KEYS[normalized]) return CTRL_KEYS[normalized];

  let rest = normalized;
  let ctrl = false;
  let alt = false;
  let shift = false;

  while (rest.length > 2) {
    if (rest.startsWith("ctrl+") || rest.startsWith("ctrl-")) {
      ctrl = true;
      rest = rest.slice(5);
    } else if (rest.startsWith("alt+") || rest.startsWith("alt-")) {
      alt = true;
      rest = rest.slice(4);
    } else if (rest.startsWith("shift+") || rest.startsWith("shift-")) {
      shift = true;
      rest = rest.slice(6);
    } else if (rest.startsWith("c-")) {
      ctrl = true;
      rest = rest.slice(2);
    } else if (rest.startsWith("m-")) {
      alt = true;
      rest = rest.slice(2);
    } else if (rest.startsWith("s-")) {
      shift = true;
      rest = rest.slice(2);
    } else {
      break;
    }
  }

  if (shift && rest === "tab") return "\x1b[Z";

  const baseSeq = NAMED_KEYS[rest];
  if (baseSeq && MODIFIABLE_KEYS.has(rest) && (ctrl || alt || shift)) {
    const mod = xtermModifier(shift, alt, ctrl);
    if (mod > 1) {
      const modified = applyXtermModifier(baseSeq, mod);
      if (modified) return modified;
    }
  }

  if (rest.length === 1) {
    let char = rest;
    if (shift && /[a-z]/.test(char)) char = char.toUpperCase();
    if (ctrl) {
      const ctrlChar = CTRL_KEYS[`ctrl+${char.toLowerCase()}`];
      if (ctrlChar) char = ctrlChar;
    }
    if (alt) return altKey(char);
    return char;
  }

  if (baseSeq && alt) return `\x1b${baseSeq}`;

  throw new Error(`Unsupported key token: ${token}`);
}

function altKey(char: string): string {
  return `\x1b${char}`;
}

function xtermModifier(shift: boolean, alt: boolean, ctrl: boolean): number {
  let mod = 1;
  if (shift) mod += 1;
  if (alt) mod += 2;
  if (ctrl) mod += 4;
  return mod;
}

function applyXtermModifier(sequence: string, modifier: number): string | null {
  const arrowMatch = sequence.match(/^\x1b\[([A-D])$/);
  if (arrowMatch) return `\x1b[1;${modifier}${arrowMatch[1]}`;

  const numMatch = sequence.match(/^\x1b\[(\d+)~$/);
  if (numMatch) return `\x1b[${numMatch[1]};${modifier}~`;

  const hfMatch = sequence.match(/^\x1b\[([HF])$/);
  if (hfMatch) return `\x1b[1;${modifier}${hfMatch[1]}`;

  return null;
}
