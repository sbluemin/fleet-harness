export type KeyId =
  | "alt+o"
  | "backspace"
  | "down"
  | "end"
  | "enter"
  | "escape"
  | "home"
  | "left"
  | "pagedown"
  | "pageup"
  | "right"
  | "t"
  | "up";

export const Key = {
  alt(key: "o"): KeyId {
    return `alt+${key}` as KeyId;
  },
} as const;

const KEY_SEQUENCES: Record<KeyId, readonly string[]> = {
  "alt+o": ["\x1bo", "\x1bO"],
  backspace: ["\x7f", "\b"],
  down: ["\x1b[B"],
  end: ["\x1b[F", "\x1b[4~", "\x1b[8~"],
  enter: ["\r", "\n"],
  escape: ["\x1b"],
  home: ["\x1b[H", "\x1b[1~", "\x1b[7~"],
  left: ["\x1b[D"],
  pagedown: ["\x1b[6~"],
  pageup: ["\x1b[5~"],
  right: ["\x1b[C"],
  t: ["t", "T"],
  up: ["\x1b[A"],
};

export function matchesKey(data: string, keyId: KeyId): boolean {
  return KEY_SEQUENCES[keyId].includes(data);
}

export function isPrintable(data: string): boolean {
  return data.length > 0 && !data.startsWith("\x1b") && !/[\x00-\x1f\x7f]/.test(data);
}
