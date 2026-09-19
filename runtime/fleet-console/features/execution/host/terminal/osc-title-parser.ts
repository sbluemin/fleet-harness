const ESC = 0x1b;
const BEL = 0x07;
const OSC = 0x5d;
const STRING_TERMINATOR = 0x5c;
const ASCII_ZERO = 0x30;
const ASCII_TWO = 0x32;
const SEMICOLON = 0x3b;
const DEFAULT_OSC_TITLE_RESIDUAL_LIMIT = 8_192;
const EMPTY_TITLES: readonly string[] = [];

export interface OscTitleParser {
  push(chunk: Buffer): readonly string[];
  reset(): void;
}

export function createOscTitleParser(residualLimit = DEFAULT_OSC_TITLE_RESIDUAL_LIMIT): OscTitleParser {
  let residual: Buffer | undefined;

  function push(chunk: Buffer): readonly string[] {
    if (chunk.length === 0) return EMPTY_TITLES;
    if (!residual && chunk.indexOf(ESC) === -1) return EMPTY_TITLES;

    const source = residual ? Buffer.concat([residual, chunk]) : chunk;
    residual = undefined;
    let titles: string[] | undefined;
    let cursor = 0;

    while (cursor < source.length) {
      const start = source.indexOf(ESC, cursor);
      if (start === -1) break;
      const prefix = readOscTitlePrefix(source, start);
      if (prefix === "partial") {
        residual = retainResidual(source, start, residualLimit);
        break;
      }
      if (prefix === "invalid") {
        cursor = start + 1;
        continue;
      }

      const titleStart = start + 4;
      let index = titleStart;
      let titleEnd = -1;
      let sequenceEnd = -1;
      while (index < source.length) {
        const byte = source[index];
        if (byte === BEL) {
          titleEnd = index;
          sequenceEnd = index + 1;
          break;
        }
        if (byte === ESC) {
          if (index + 1 >= source.length) break;
          if (source[index + 1] === STRING_TERMINATOR) {
            titleEnd = index;
            sequenceEnd = index + 2;
            break;
          }
        }
        index += 1;
      }

      if (sequenceEnd === -1) {
        residual = retainResidual(source, start, residualLimit);
        break;
      }
      (titles ??= []).push(source.toString("utf8", titleStart, titleEnd));
      cursor = sequenceEnd;
    }

    return titles ?? EMPTY_TITLES;
  }

  return {
    push,
    reset: () => {
      residual = undefined;
    },
  };
}

function readOscTitlePrefix(source: Buffer, start: number): "valid" | "invalid" | "partial" {
  if (start + 1 >= source.length) return "partial";
  if (source[start + 1] !== OSC) return "invalid";
  if (start + 2 >= source.length) return "partial";
  if (source[start + 2] !== ASCII_ZERO && source[start + 2] !== ASCII_TWO) return "invalid";
  if (start + 3 >= source.length) return "partial";
  return source[start + 3] === SEMICOLON ? "valid" : "invalid";
}

function retainResidual(source: Buffer, start: number, limit: number): Buffer | undefined {
  const length = source.length - start;
  if (limit <= 0 || length > limit) return undefined;
  return Buffer.from(source.subarray(start));
}
