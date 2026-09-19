/**
 * 에이전트·사용자 키 입력을 CDP `Input.dispatchKeyEvent` 인자로 옮긴다.
 *
 * 에이전트는 xdotool 문법("Return", "cmd+a", "shift+Tab")으로 말하고, 브라우저 UI는 DOM KeyboardEvent의
 * key/code 를 그대로 보낸다. 두 입력이 같은 표로 떨어져야 같은 페이지에 같은 키가 닿는다.
 */

export interface KeyDescriptor {
  readonly key: string;
  readonly code: string;
  readonly keyCode: number;
  readonly text?: string;
}

const NAMED: Record<string, KeyDescriptor> = {
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  page_up: { key: "PageUp", code: "PageUp", keyCode: 33 },
  page_down: { key: "PageDown", code: "PageDown", keyCode: 34 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
  f1: { key: "F1", code: "F1", keyCode: 112 }, f2: { key: "F2", code: "F2", keyCode: 113 }, f3: { key: "F3", code: "F3", keyCode: 114 }, f4: { key: "F4", code: "F4", keyCode: 115 },
  f5: { key: "F5", code: "F5", keyCode: 116 }, f6: { key: "F6", code: "F6", keyCode: 117 }, f7: { key: "F7", code: "F7", keyCode: 118 }, f8: { key: "F8", code: "F8", keyCode: 119 },
  f9: { key: "F9", code: "F9", keyCode: 120 }, f10: { key: "F10", code: "F10", keyCode: 121 }, f11: { key: "F11", code: "F11", keyCode: 122 }, f12: { key: "F12", code: "F12", keyCode: 123 },
  minus: { key: "-", code: "Minus", keyCode: 189, text: "-" },
  plus: { key: "+", code: "Equal", keyCode: 187, text: "+" },
  equal: { key: "=", code: "Equal", keyCode: 187, text: "=" },
  comma: { key: ",", code: "Comma", keyCode: 188, text: "," },
  period: { key: ".", code: "Period", keyCode: 190, text: "." },
  slash: { key: "/", code: "Slash", keyCode: 191, text: "/" },
  semicolon: { key: ";", code: "Semicolon", keyCode: 186, text: ";" },
  apostrophe: { key: "'", code: "Quote", keyCode: 222, text: "'" },
  bracketleft: { key: "[", code: "BracketLeft", keyCode: 219, text: "[" },
  bracketright: { key: "]", code: "BracketRight", keyCode: 221, text: "]" },
  backslash: { key: "\\", code: "Backslash", keyCode: 220, text: "\\" },
  grave: { key: "`", code: "Backquote", keyCode: 192, text: "`" },
};

export interface Modifiers { readonly alt: boolean; readonly ctrl: boolean; readonly meta: boolean; readonly shift: boolean }
const NONE: Modifiers = { alt: false, ctrl: false, meta: false, shift: false };

/** CDP modifiers 비트: Alt=1, Ctrl=2, Meta=4, Shift=8. */
export function modifierBits(mods: Modifiers): number {
  return (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0);
}

function single(char: string, shift: boolean): KeyDescriptor {
  const upper = char.toUpperCase();
  if (/^[a-z]$/i.test(char)) return { key: shift ? upper : char.toLowerCase(), code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: shift ? upper : char.toLowerCase() };
  if (/^[0-9]$/.test(char)) return { key: char, code: `Digit${char}`, keyCode: char.charCodeAt(0), text: char };
  return { key: char, code: "", keyCode: 0, text: char };
}

/**
 * "cmd+shift+a" 같은 조합을 해석한다. 모르는 이름은 null — 호출자가 거부 응답을 만든다.
 * `super`·`cmd`·`command`·`meta`는 Meta, `ctrl`·`control`은 Control, `alt`·`option`은 Alt.
 */
export function parseKeyChord(chord: string): { readonly descriptor: KeyDescriptor; readonly modifiers: Modifiers } | null {
  const parts = chord.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const mods = { ...NONE };
  const names = parts.slice(0, -1).map((part) => part.toLowerCase());
  for (const name of names) {
    if (name === "cmd" || name === "command" || name === "super" || name === "meta") mods.meta = true;
    else if (name === "ctrl" || name === "control") mods.ctrl = true;
    else if (name === "alt" || name === "option") mods.alt = true;
    else if (name === "shift") mods.shift = true;
    else return null;
  }
  const last = parts[parts.length - 1] ?? "";
  const named = NAMED[last.toLowerCase()];
  const descriptor = named ?? (last.length === 1 ? single(last, mods.shift) : null);
  if (!descriptor) return null;
  // 수식키가 있으면 문자는 입력되지 않는다 — Ctrl+A 가 "a"를 타이핑하면 안 된다.
  const text = mods.ctrl || mods.meta || mods.alt ? undefined : descriptor.text;
  return { descriptor: { ...descriptor, ...(text === undefined ? { text: undefined } : { text }) }, modifiers: mods };
}

/** DOM KeyboardEvent(key, code)를 CDP 인자로 — 브라우저 패널이 보내는 사용자 키 입력용. */
export function describeDomKey(key: string, code: string, modifiers: Modifiers): KeyDescriptor {
  const named = NAMED[key.toLowerCase()] ?? (code ? Object.values(NAMED).find((entry) => entry.code === code) : undefined);
  if (named) return { ...named, text: modifiers.ctrl || modifiers.meta || modifiers.alt ? undefined : named.text };
  const printable = key.length === 1 && !modifiers.ctrl && !modifiers.meta && !modifiers.alt;
  const codeMatch = /^Key([A-Z])$/.exec(code);
  return { key, code, keyCode: codeMatch ? codeMatch[1]!.charCodeAt(0) : key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0, ...(printable ? { text: key } : {}) };
}
