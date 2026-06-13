// SSoT: runtime/fleet-cli/src/styles (ansi/help-tokens/palette/brand) 및
// runtime/fleet-wiki-ui/src/help-style.ts와 동일한 CLI-help 스타일 헬퍼.
// 독트린상 이 파일은 fleet-cli/packages/*를 import할 수 없는 CLI-help 전용 self-hosted
// 사본이므로, fleet-cli styles 쪽 브랜드/SGR 변경 시 이 파일에도 수동 동기화가 필요하다.

export interface ResolveColorEnabledOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
}

export const ANSI_RESET = "\x1b[0m";
export const ANSI_BOLD = "\x1b[1m";
export const ANSI_DIM = "\x1b[2m";
export const FLEET_ACCENT = "\x1b[38;2;254;188;56m";
export const FLEET_OPTION = "\x1b[38;2;125;211;252m";
export const FLEET_COMMAND = "\x1b[38;2;94;234;212m";
export const GRADIENT_COLORS: readonly string[] = [
  "\x1b[38;2;0;255;255m",
  "\x1b[38;2;0;215;255m",
  "\x1b[38;2;0;175;255m",
  "\x1b[38;2;0;135;255m",
  "\x1b[38;2;0;95;255m",
  "\x1b[38;2;0;0;255m",
];

export const ASCII_FLEET_BANNER: readonly string[] = [
  "███████╗██╗     ███████╗███████╗████████╗",
  "██╔════╝██║     ██╔════╝██╔════╝╚══██╔══╝",
  "█████╗  ██║     █████╗  █████╗     ██║   ",
  "██╔══╝  ██║     ██╔══╝  ██╔══╝     ██║   ",
  "██║     ███████╗███████╗███████╗   ██║   ",
  "╚═╝     ╚══════╝╚══════╝╚══════╝   ╚═╝   ",
];

const BEL = "\x07";
const C1_APC = 0x9f;
const C1_CSI = 0x9b;
const C1_DCS = 0x90;
const C1_OSC = 0x9d;
const C1_PM = 0x9e;
const C1_SOS = 0x98;
const C1_ST = "\x9c";
const CSI_FINAL_END = 0x7e;
const CSI_FINAL_START = 0x40;
const ESC = "\x1b";
const ESC_APC = "_";
const ESC_CSI = "[";
const ESC_DCS = "P";
const ESC_OSC = "]";
const ESC_PM = "^";
const ESC_SOS = "X";
const ESC_ST = "\\";

export function stripAnsi(text: string): string {
  // SGR 색상뿐 아니라 OSC/DCS 같은 터미널 제어 시퀀스까지 제거한다.
  let output = "";
  let index = 0;
  while (index < text.length) {
    const controlSequence = readControlSequence(text, index);
    if (controlSequence) {
      index += controlSequence.length;
      continue;
    }

    output += text[index];
    index += 1;
  }
  return output;
}

export function paint(color: string, text: string, colorEnabled: boolean): string {
  if (!colorEnabled) {
    return text;
  }
  return `${color}${text}${ANSI_RESET}`;
}

export function resolveColorEnabled(options: ResolveColorEnabledOptions = {}): boolean {
  const env = options.env ?? process.env;
  const isTTY = options.isTTY ?? process.stdout.isTTY;
  return isTTY === true && env.NO_COLOR === undefined;
}

export function section(text: string, colorEnabled: boolean): string {
  return paint(`${ANSI_BOLD}${FLEET_ACCENT}`, text, colorEnabled);
}

export function command(text: string, colorEnabled: boolean): string {
  return paint(FLEET_COMMAND, text, colorEnabled);
}

export function option(text: string, colorEnabled: boolean): string {
  return paint(FLEET_OPTION, text, colorEnabled);
}

export function dim(text: string, colorEnabled: boolean): string {
  return paint(ANSI_DIM, text, colorEnabled);
}

function readControlSequence(text: string, index: number): string | undefined {
  const code = text.charCodeAt(index);
  if (code === 0x1b) {
    return readEscControlSequence(text, index);
  }
  if (isC1Control(code)) {
    return readC1ControlSequence(text, index);
  }
  return undefined;
}

function readEscControlSequence(text: string, index: number): string {
  const introducer = text[index + 1];
  if (introducer === undefined) {
    return text.slice(index);
  }
  if (introducer === ESC_CSI) {
    return readCsiSequence(text, index, index + 2);
  }
  if (introducer === ESC_OSC) {
    return readStringControlSequence(text, index, index + 2, true);
  }
  if (introducer === ESC_DCS || introducer === ESC_PM || introducer === ESC_APC || introducer === ESC_SOS) {
    return readStringControlSequence(text, index, index + 2, false);
  }
  return text.slice(index, Math.min(text.length, index + 2));
}

function readC1ControlSequence(text: string, index: number): string {
  const code = text.charCodeAt(index);
  if (code === C1_CSI) {
    return readCsiSequence(text, index, index + 1);
  }
  if (code === C1_OSC) {
    return readStringControlSequence(text, index, index + 1, true);
  }
  if (code === C1_DCS || code === C1_PM || code === C1_APC || code === C1_SOS) {
    return readStringControlSequence(text, index, index + 1, false);
  }
  return text[index] ?? "";
}

function readCsiSequence(text: string, start: number, scanStart: number): string {
  for (let index = scanStart; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= CSI_FINAL_START && code <= CSI_FINAL_END) {
      return text.slice(start, index + 1);
    }
  }
  return text.slice(start);
}

function readStringControlSequence(text: string, start: number, scanStart: number, allowBelTerminator: boolean): string {
  for (let index = scanStart; index < text.length; index += 1) {
    const char = text[index];
    if (allowBelTerminator && char === BEL) {
      return text.slice(start, index + 1);
    }
    if (char === C1_ST) {
      return text.slice(start, index + 1);
    }
    if (char === ESC && text[index + 1] === ESC_ST) {
      return text.slice(start, index + 2);
    }
  }
  return text.slice(start);
}

function isC1Control(code: number): boolean {
  return code >= 0x80 && code <= 0x9f;
}
