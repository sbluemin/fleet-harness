const ESC = 0x1b;
const BEL = 0x07;
const OSC = 0x5d;
const STRING_TERMINATOR = 0x5c;
const ASCII_ZERO = 0x30;
const ASCII_NINE = 0x39;
const SEMICOLON = 0x3b;
// OSC 번호는 짧다(0·2·7·133 …). 이보다 긴 숫자열은 우리가 읽을 시퀀스가 아니다.
const MAX_OSC_CODE_DIGITS = 4;
const DEFAULT_OSC_RESIDUAL_LIMIT = 8_192;
const EMPTY_PAYLOADS: readonly string[] = [];

export interface OscTitleParser {
  push(chunk: Buffer): readonly string[];
  reset(): void;
}

/** OSC 0/2(창 제목). */
export function createOscTitleParser(residualLimit = DEFAULT_OSC_RESIDUAL_LIMIT): OscTitleParser {
  return createOscPayloadParser(["0", "2"], residualLimit);
}

/**
 * OSC 7(현재 작업 디렉터리 보고) — `ESC ] 7 ; file://host/path BEL|ST`.
 *
 * 돌려주는 것은 퍼센트 디코딩한 절대 경로다. 다른 기계의 호스트명이 찍힌 보고(ssh 안의 셸)는
 * 이 기계의 경로가 아니므로 버린다 — 그 경로로 Theater를 찾으면 엉뚱한 저장소를 가리킨다.
 */
export function createOscCwdParser(localHostnames: readonly string[], residualLimit = DEFAULT_OSC_RESIDUAL_LIMIT): OscTitleParser {
  const payloads = createOscPayloadParser(["7"], residualLimit);
  const hosts = new Set(["", "localhost", ...localHostnames.map((name) => name.toLowerCase())]);
  return {
    push: (chunk) => {
      const reported = payloads.push(chunk);
      if (reported.length === 0) return EMPTY_PAYLOADS;
      const paths: string[] = [];
      for (const payload of reported) {
        const cwd = readFileUrlPath(payload, hosts);
        if (cwd) paths.push(cwd);
      }
      return paths;
    },
    reset: payloads.reset,
  };
}

function readFileUrlPath(payload: string, localHosts: ReadonlySet<string>): string | null {
  let url: URL;
  try {
    url = new URL(payload);
  } catch {
    return null;
  }
  if (url.protocol !== "file:") return null;
  if (!localHosts.has(url.hostname.toLowerCase())) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  return decoded.startsWith("/") && !decoded.includes("\0") ? decoded : null;
}

function createOscPayloadParser(codes: readonly string[], residualLimit: number): OscTitleParser {
  const accepted = new Set(codes);
  let residual: Buffer | undefined;

  function push(chunk: Buffer): readonly string[] {
    if (chunk.length === 0) return EMPTY_PAYLOADS;
    if (!residual && chunk.indexOf(ESC) === -1) return EMPTY_PAYLOADS;

    const source = residual ? Buffer.concat([residual, chunk]) : chunk;
    residual = undefined;
    let payloads: string[] | undefined;
    let cursor = 0;

    while (cursor < source.length) {
      const start = source.indexOf(ESC, cursor);
      if (start === -1) break;
      const prefix = readOscPrefix(source, start, accepted);
      if (prefix === "partial") {
        residual = retainResidual(source, start, residualLimit);
        break;
      }
      if (prefix === "invalid") {
        cursor = start + 1;
        continue;
      }

      const payloadStart = prefix;
      let index = payloadStart;
      let payloadEnd = -1;
      let sequenceEnd = -1;
      while (index < source.length) {
        const byte = source[index];
        if (byte === BEL) {
          payloadEnd = index;
          sequenceEnd = index + 1;
          break;
        }
        if (byte === ESC) {
          if (index + 1 >= source.length) break;
          if (source[index + 1] === STRING_TERMINATOR) {
            payloadEnd = index;
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
      (payloads ??= []).push(source.toString("utf8", payloadStart, payloadEnd));
      cursor = sequenceEnd;
    }

    return payloads ?? EMPTY_PAYLOADS;
  }

  return {
    push,
    reset: () => {
      residual = undefined;
    },
  };
}

/** 받아들일 OSC면 payload 시작 위치, 아니면 "invalid", 청크 끝에서 잘렸으면 "partial". */
function readOscPrefix(source: Buffer, start: number, accepted: ReadonlySet<string>): number | "invalid" | "partial" {
  if (start + 1 >= source.length) return "partial";
  if (source[start + 1] !== OSC) return "invalid";
  let index = start + 2;
  while (index < source.length && index - (start + 2) <= MAX_OSC_CODE_DIGITS) {
    const byte = source[index]!;
    if (byte === SEMICOLON) {
      const code = source.toString("latin1", start + 2, index);
      return code.length > 0 && accepted.has(code) ? index + 1 : "invalid";
    }
    if (byte < ASCII_ZERO || byte > ASCII_NINE) return "invalid";
    index += 1;
  }
  return index >= source.length ? "partial" : "invalid";
}

function retainResidual(source: Buffer, start: number, limit: number): Buffer | undefined {
  const length = source.length - start;
  if (limit <= 0 || length > limit) return undefined;
  return Buffer.from(source.subarray(start));
}
