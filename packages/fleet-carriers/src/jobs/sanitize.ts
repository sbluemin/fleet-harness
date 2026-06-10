const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const MULTILINE_CONTROL_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f]/g;
const LINE_BREAKS = /[\r\n]+/g;
const CR_LINE_BREAKS = /\r\n?/g;

export function sanitizeChunk(text: string): string {
  return stripTerminalControlSequences(text)
    .replace(CR_LINE_BREAKS, "\n")
    .replace(MULTILINE_CONTROL_CHARS, "");
}

export function sanitizeToolBlockLabel(value: string): string {
  return sanitizeOneLineText(value);
}

export function sanitizeToolLabel(text: string): string {
  return sanitizeToolBlockLabel(text).replace(/\s+/g, " ").trim() || "(unnamed)";
}

export function sanitizeOneLineText(text: string): string {
  return stripTerminalControlSequences(text)
    .replace(LINE_BREAKS, " ")
    .replace(CONTROL_CHARS, "");
}

export function stripTerminalControlSequences(text: string): string {
  let result = "";
  let index = 0;

  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x1b) {
      index = skipEscSequence(text, index);
      continue;
    }
    if (isC1Control(code)) {
      index = skipC1Sequence(text, index);
      continue;
    }

    result += text[index] ?? "";
    index++;
  }

  return result;
}

function skipEscSequence(text: string, index: number): number {
  const next = text.charCodeAt(index + 1);
  if (Number.isNaN(next)) return index + 1;

  if (next === 0x5b) return skipControlSequence(text, index + 2);
  if (next === 0x5d) return skipStringControl(text, index + 2, true);
  if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
    return skipStringControl(text, index + 2, false);
  }
  if (isEscIntermediate(next)) {
    let cursor = index + 1;
    while (cursor < text.length && isEscIntermediate(text.charCodeAt(cursor))) cursor++;
    return cursor < text.length ? cursor + 1 : cursor;
  }

  return index + 2;
}

function skipC1Sequence(text: string, index: number): number {
  const code = text.charCodeAt(index);
  if (code === 0x9b) return skipControlSequence(text, index + 1);
  if (code === 0x9d) return skipStringControl(text, index + 1, true);
  if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
    return skipStringControl(text, index + 1, false);
  }
  return index + 1;
}

function skipControlSequence(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (code >= 0x40 && code <= 0x7e) return cursor + 1;
    cursor++;
  }
  return cursor;
}

function skipStringControl(text: string, index: number, allowBel: boolean): number {
  let cursor = index;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (allowBel && code === 0x07) return cursor + 1;
    if (code === 0x9c) return cursor + 1;
    if (code === 0x1b && text.charCodeAt(cursor + 1) === 0x5c) return cursor + 2;
    cursor++;
  }
  return cursor;
}

function isC1Control(code: number): boolean {
  return code >= 0x80 && code <= 0x9f;
}

function isEscIntermediate(code: number): boolean {
  return code >= 0x20 && code <= 0x2f;
}
