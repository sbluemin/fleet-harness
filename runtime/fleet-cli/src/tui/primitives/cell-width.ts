interface AnsiToken {
  readonly sequence: string;
  readonly kind: "sgr" | "control";
  readonly codes: readonly number[];
}

interface SegmenterLike {
  readonly segment: (input: string) => Iterable<{ readonly segment: string }>;
}

const ANSI_RESET = "\x1b[0m";
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
const SGR_FINAL = "m";
const ZERO_WIDTH_JOINER = 0x200d;
const VARIATION_SELECTOR_START = 0xfe00;
const VARIATION_SELECTOR_END = 0xfe0f;
const VARIATION_SELECTOR_SUPPLEMENT_START = 0xe0100;
const VARIATION_SELECTOR_SUPPLEMENT_END = 0xe01ef;
const COMBINING_RANGES: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x05bf, 0x05bf],
  [0x05c1, 0x05c2],
  [0x05c4, 0x05c5],
  [0x05c7, 0x05c7],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x06df, 0x06e4],
  [0x06e7, 0x06e8],
  [0x06ea, 0x06ed],
  [0x0711, 0x0711],
  [0x0730, 0x074a],
  [0x07a6, 0x07b0],
  [0x07eb, 0x07f3],
  [0x0816, 0x0819],
  [0x081b, 0x0823],
  [0x0825, 0x0827],
  [0x0829, 0x082d],
  [0x0859, 0x085b],
  [0x08d3, 0x08ff],
  [0x0900, 0x0902],
  [0x093a, 0x093a],
  [0x093c, 0x093c],
  [0x0941, 0x0948],
  [0x094d, 0x094d],
  [0x0951, 0x0957],
  [0x0962, 0x0963],
  [0x0981, 0x0981],
  [0x09bc, 0x09bc],
  [0x09c1, 0x09c4],
  [0x09cd, 0x09cd],
  [0x09e2, 0x09e3],
  [0x0a01, 0x0a02],
  [0x0a3c, 0x0a3c],
  [0x0a41, 0x0a42],
  [0x0a47, 0x0a48],
  [0x0a4b, 0x0a4d],
  [0x0a51, 0x0a51],
  [0x0a70, 0x0a71],
  [0x0a75, 0x0a75],
  [0x0a81, 0x0a82],
  [0x0abc, 0x0abc],
  [0x0ac1, 0x0ac5],
  [0x0ac7, 0x0ac8],
  [0x0acd, 0x0acd],
  [0x0ae2, 0x0ae3],
  [0x0b01, 0x0b01],
  [0x0b3c, 0x0b3c],
  [0x0b3f, 0x0b3f],
  [0x0b41, 0x0b44],
  [0x0b4d, 0x0b4d],
  [0x0b56, 0x0b56],
  [0x0b62, 0x0b63],
  [0x0b82, 0x0b82],
  [0x0bc0, 0x0bc0],
  [0x0bcd, 0x0bcd],
  [0x0c00, 0x0c00],
  [0x0c04, 0x0c04],
  [0x0c3e, 0x0c40],
  [0x0c46, 0x0c48],
  [0x0c4a, 0x0c4d],
  [0x0c55, 0x0c56],
  [0x0c62, 0x0c63],
  [0x0c81, 0x0c81],
  [0x0cbc, 0x0cbc],
  [0x0cbf, 0x0cbf],
  [0x0cc6, 0x0cc6],
  [0x0ccc, 0x0ccd],
  [0x0ce2, 0x0ce3],
  [0x0d00, 0x0d01],
  [0x0d3b, 0x0d3c],
  [0x0d41, 0x0d44],
  [0x0d4d, 0x0d4d],
  [0x0d62, 0x0d63],
  [0x0dca, 0x0dca],
  [0x0dd2, 0x0dd4],
  [0x0dd6, 0x0dd6],
  [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e],
  [0x0eb1, 0x0eb1],
  [0x0eb4, 0x0ebc],
  [0x0ec8, 0x0ecd],
  [0x0f18, 0x0f19],
  [0x0f35, 0x0f35],
  [0x0f37, 0x0f37],
  [0x0f39, 0x0f39],
  [0x0f71, 0x0f7e],
  [0x0f80, 0x0f84],
  [0x0f86, 0x0f87],
  [0x0f8d, 0x0f97],
  [0x0f99, 0x0fbc],
  [0x0fc6, 0x0fc6],
  [0x102d, 0x1030],
  [0x1032, 0x1037],
  [0x1039, 0x103a],
  [0x103d, 0x103e],
  [0x1058, 0x1059],
  [0x105e, 0x1060],
  [0x1071, 0x1074],
  [0x1082, 0x1082],
  [0x1085, 0x1086],
  [0x108d, 0x108d],
  [0x109d, 0x109d],
  [0x135d, 0x135f],
  [0x1712, 0x1714],
  [0x1732, 0x1734],
  [0x1752, 0x1753],
  [0x1772, 0x1773],
  [0x17b4, 0x17b5],
  [0x17b7, 0x17bd],
  [0x17c6, 0x17c6],
  [0x17c9, 0x17d3],
  [0x17dd, 0x17dd],
  [0x180b, 0x180f],
  [0x1885, 0x1886],
  [0x18a9, 0x18a9],
  [0x1920, 0x1922],
  [0x1927, 0x1928],
  [0x1932, 0x1932],
  [0x1939, 0x193b],
  [0x1a17, 0x1a18],
  [0x1a1b, 0x1a1b],
  [0x1a56, 0x1a56],
  [0x1a58, 0x1a5e],
  [0x1a60, 0x1a60],
  [0x1a62, 0x1a62],
  [0x1a65, 0x1a6c],
  [0x1a73, 0x1a7c],
  [0x1a7f, 0x1a7f],
  [0x1ab0, 0x1aff],
  [0x1b00, 0x1b03],
  [0x1b34, 0x1b34],
  [0x1b36, 0x1b3a],
  [0x1b3c, 0x1b3c],
  [0x1b42, 0x1b42],
  [0x1b6b, 0x1b73],
  [0x1b80, 0x1b81],
  [0x1ba2, 0x1ba5],
  [0x1ba8, 0x1ba9],
  [0x1bab, 0x1bad],
  [0x1be6, 0x1be6],
  [0x1be8, 0x1be9],
  [0x1bed, 0x1bed],
  [0x1bef, 0x1bf1],
  [0x1c2c, 0x1c33],
  [0x1c36, 0x1c37],
  [0x1cd0, 0x1cd2],
  [0x1cd4, 0x1ce0],
  [0x1ce2, 0x1ce8],
  [0x1ced, 0x1ced],
  [0x1cf4, 0x1cf4],
  [0x1cf8, 0x1cf9],
  [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff],
  [0x2cef, 0x2cf1],
  [0x2d7f, 0x2d7f],
  [0x2de0, 0x2dff],
  [0x302a, 0x302f],
  [0x3099, 0x309a],
  [0xa66f, 0xa672],
  [0xa674, 0xa67d],
  [0xa69e, 0xa69f],
  [0xa6f0, 0xa6f1],
  [0xa802, 0xa802],
  [0xa806, 0xa806],
  [0xa80b, 0xa80b],
  [0xa825, 0xa826],
  [0xa8c4, 0xa8c5],
  [0xa8e0, 0xa8f1],
  [0xa926, 0xa92d],
  [0xa947, 0xa951],
  [0xa980, 0xa982],
  [0xa9b3, 0xa9b3],
  [0xa9b6, 0xa9b9],
  [0xa9bc, 0xa9bc],
  [0xa9e5, 0xa9e5],
  [0xaa29, 0xaa2e],
  [0xaa31, 0xaa32],
  [0xaa35, 0xaa36],
  [0xaa43, 0xaa43],
  [0xaa4c, 0xaa4c],
  [0xaa7c, 0xaa7c],
  [0xaab0, 0xaab0],
  [0xaab2, 0xaab4],
  [0xaab7, 0xaab8],
  [0xaabe, 0xaabf],
  [0xaac1, 0xaac1],
  [0xaaec, 0xaaed],
  [0xaaf6, 0xaaf6],
  [0xabe5, 0xabe5],
  [0xabe8, 0xabe8],
  [0xabed, 0xabed],
  [0xfb1e, 0xfb1e],
  [0xfe20, 0xfe2f],
  [0x101fd, 0x101fd],
  [0x102e0, 0x102e0],
  [0x10376, 0x1037a],
  [0x10a01, 0x10a03],
  [0x10a05, 0x10a06],
  [0x10a0c, 0x10a0f],
  [0x10a38, 0x10a3a],
  [0x10a3f, 0x10a3f],
  [0x10ae5, 0x10ae6],
  [0x10d24, 0x10d27],
  [0x10eab, 0x10eac],
  [0x10f46, 0x10f50],
  [0x11001, 0x11001],
  [0x11038, 0x11046],
  [0x1107f, 0x11081],
  [0x110b3, 0x110b6],
  [0x110b9, 0x110ba],
  [0x11100, 0x11102],
  [0x11127, 0x1112b],
  [0x1112d, 0x11134],
  [0x11173, 0x11173],
  [0x11180, 0x11181],
  [0x111b6, 0x111be],
  [0x111c9, 0x111cc],
  [0x111cf, 0x111cf],
  [0x1122f, 0x11231],
  [0x11234, 0x11234],
  [0x11236, 0x11237],
  [0x1123e, 0x1123e],
  [0x112df, 0x112df],
  [0x112e3, 0x112ea],
  [0x11300, 0x11301],
  [0x1133b, 0x1133c],
  [0x11340, 0x11340],
  [0x11366, 0x1136c],
  [0x11370, 0x11374],
  [0x11438, 0x1143f],
  [0x11442, 0x11444],
  [0x11446, 0x11446],
  [0x1145e, 0x1145e],
  [0x114b3, 0x114b8],
  [0x114ba, 0x114ba],
  [0x114bf, 0x114c0],
  [0x114c2, 0x114c3],
  [0x115b2, 0x115b5],
  [0x115bc, 0x115bd],
  [0x115bf, 0x115c0],
  [0x11633, 0x1163a],
  [0x1163d, 0x1163d],
  [0x1163f, 0x11640],
  [0x116ab, 0x116ab],
  [0x116ad, 0x116ad],
  [0x116b0, 0x116b5],
  [0x116b7, 0x116b7],
  [0x1171d, 0x1171f],
  [0x11722, 0x11725],
  [0x11727, 0x1172b],
  [0x1182f, 0x11837],
  [0x11839, 0x1183a],
  [0x1193b, 0x1193c],
  [0x1193e, 0x1193e],
  [0x11943, 0x11943],
  [0x119d4, 0x119d7],
  [0x119da, 0x119db],
  [0x119e0, 0x119e0],
  [0x11a01, 0x11a0a],
  [0x11a33, 0x11a38],
  [0x11a3b, 0x11a3e],
  [0x11a47, 0x11a47],
  [0x11a51, 0x11a56],
  [0x11a59, 0x11a5b],
  [0x11a8a, 0x11a96],
  [0x11a98, 0x11a99],
  [0x11c30, 0x11c36],
  [0x11c38, 0x11c3d],
  [0x11c3f, 0x11c3f],
  [0x11c92, 0x11ca7],
  [0x11caa, 0x11cb0],
  [0x11cb2, 0x11cb3],
  [0x11cb5, 0x11cb6],
  [0x11d31, 0x11d36],
  [0x11d3a, 0x11d3a],
  [0x11d3c, 0x11d3d],
  [0x11d3f, 0x11d45],
  [0x11d47, 0x11d47],
  [0x11d90, 0x11d91],
  [0x11d95, 0x11d95],
  [0x11d97, 0x11d97],
  [0x11ef3, 0x11ef4],
  [0x16af0, 0x16af4],
  [0x16b30, 0x16b36],
  [0x16f4f, 0x16f4f],
  [0x16f8f, 0x16f92],
  [0x16fe4, 0x16fe4],
  [0x1bc9d, 0x1bc9e],
  [0x1d165, 0x1d169],
  [0x1d16d, 0x1d172],
  [0x1d17b, 0x1d182],
  [0x1d185, 0x1d18b],
  [0x1d1aa, 0x1d1ad],
  [0x1d242, 0x1d244],
  [0x1da00, 0x1da36],
  [0x1da3b, 0x1da6c],
  [0x1da75, 0x1da75],
  [0x1da84, 0x1da84],
  [0x1da9b, 0x1da9f],
  [0x1daa1, 0x1daaf],
  [0x1e000, 0x1e006],
  [0x1e008, 0x1e018],
  [0x1e01b, 0x1e021],
  [0x1e023, 0x1e024],
  [0x1e026, 0x1e02a],
  [0x1e130, 0x1e136],
  [0x1e2ae, 0x1e2ae],
  [0x1e2ec, 0x1e2ef],
  [0x1e8d0, 0x1e8d6],
  [0x1e944, 0x1e94a],
  [0xe0100, 0xe01ef],
];
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3040, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x16ff0, 0x16ff1],
  [0x17000, 0x187f7],
  [0x18800, 0x18cd5],
  [0x18d00, 0x18d08],
  [0x1aff0, 0x1aff3],
  [0x1aff5, 0x1affb],
  [0x1affd, 0x1affe],
  [0x1b000, 0x1b122],
  [0x1b132, 0x1b132],
  [0x1b150, 0x1b152],
  [0x1b155, 0x1b155],
  [0x1b164, 0x1b167],
  [0x1b170, 0x1b2fb],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f202],
  [0x1f210, 0x1f23b],
  [0x1f240, 0x1f248],
  [0x1f250, 0x1f251],
  [0x1f260, 0x1f265],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f700, 0x1f77f],
  [0x1f780, 0x1f7ff],
  [0x1f800, 0x1f8ff],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];
const GRAPHEME_SEGMENTER: SegmenterLike | undefined =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

export function visibleWidth(text: string): number {
  let width = 0;
  for (const token of tokenizeText(text)) {
    if (typeof token === "string") {
      width += graphemeWidth(token);
    }
  }
  return width;
}

export function truncateToWidth(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  let output = "";
  let visible = 0;
  let activeSgr = false;
  let truncated = false;

  for (const token of tokenizeText(text)) {
    if (typeof token !== "string") {
      if (token.kind === "sgr") {
        output += token.sequence;
        activeSgr = updateActiveSgr(activeSgr, token.codes);
      }
      continue;
    }

    const tokenWidth = graphemeWidth(token);
    if (visible + tokenWidth > width) {
      truncated = true;
      break;
    }

    output += token;
    visible += tokenWidth;
  }

  if (truncated && activeSgr) {
    output += ANSI_RESET;
  }

  return output;
}

export function fitLine(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  const truncated = visibleWidth(text) > width ? truncateToWidth(text, width) : text;
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

export function centerLine(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  const fitted = visibleWidth(text) > width ? truncateToWidth(text, width) : text;
  const left = Math.max(0, Math.floor((width - visibleWidth(fitted)) / 2));
  return fitLine(`${" ".repeat(left)}${fitted}`, width);
}

export function stripControlSequences(text: string): string {
  return Array.from(tokenizeText(text))
    .filter((token) => typeof token === "string")
    .join("");
}

function* tokenizeText(text: string): Iterable<string | AnsiToken> {
  let index = 0;
  while (index < text.length) {
    const controlSequence = readControlSequence(text, index);
    if (controlSequence) {
      yield parseAnsiToken(controlSequence);
      index += controlSequence.length;
      continue;
    }

    const nextControlIndex = findNextControlIndex(text, index);
    const chunkEnd = nextControlIndex === -1 ? text.length : nextControlIndex;
    for (const segment of segmentGraphemes(text.slice(index, chunkEnd))) {
      yield segment;
    }
    index = chunkEnd;
  }
}

function parseAnsiToken(sequence: string): AnsiToken {
  const sgrParameters = readSgrParameters(sequence);
  if (sgrParameters === undefined) {
    return { sequence, kind: "control", codes: [] };
  }

  const codes = sgrParameters.length === 0 ? [0] : sgrParameters.split(";").map((code) => Number(code));
  return { sequence, kind: "sgr", codes };
}

function findNextControlIndex(text: string, start: number): number {
  for (let index = start; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x1b || isC1Control(code)) {
      return index;
    }
  }
  return -1;
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

function readSgrParameters(sequence: string): string | undefined {
  if (sequence.endsWith(SGR_FINAL)) {
    if (sequence.startsWith(`${ESC}${ESC_CSI}`)) {
      return sequence.slice(2, -1);
    }
    if (sequence.charCodeAt(0) === C1_CSI) {
      return sequence.slice(1, -1);
    }
  }
  return undefined;
}

function isC1Control(code: number): boolean {
  return code >= 0x80 && code <= 0x9f;
}

function* segmentGraphemes(text: string): Iterable<string> {
  if (GRAPHEME_SEGMENTER) {
    for (const part of GRAPHEME_SEGMENTER.segment(text)) {
      yield part.segment;
    }
    return;
  }

  for (const char of text) {
    yield char;
  }
}

function graphemeWidth(grapheme: string): number {
  if (grapheme.length === 0) {
    return 0;
  }

  let width = 0;
  let hasJoiner = false;
  for (const char of grapheme) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || isZeroWidth(codePoint)) {
      if (codePoint === ZERO_WIDTH_JOINER) {
        hasJoiner = true;
      }
      continue;
    }

    width = Math.max(width, codePointWidth(codePoint));
  }

  return hasJoiner ? Math.max(width, 2) : width;
}

function codePointWidth(codePoint: number): number {
  if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return 0;
  }

  return isInRanges(codePoint, WIDE_RANGES) ? 2 : 1;
}

function isZeroWidth(codePoint: number): boolean {
  return (
    codePoint === ZERO_WIDTH_JOINER ||
    (codePoint >= VARIATION_SELECTOR_START && codePoint <= VARIATION_SELECTOR_END) ||
    (codePoint >= VARIATION_SELECTOR_SUPPLEMENT_START && codePoint <= VARIATION_SELECTOR_SUPPLEMENT_END) ||
    isInRanges(codePoint, COMBINING_RANGES)
  );
}

function isInRanges(codePoint: number, ranges: readonly (readonly [number, number])[]): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const [start, end] = ranges[mid];
    if (codePoint < start) {
      high = mid - 1;
    } else if (codePoint > end) {
      low = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

function updateActiveSgr(active: boolean, codes: readonly number[]): boolean {
  if (codes.length === 0 || codes.includes(0)) {
    return false;
  }

  if (codes.some((code) => code >= 1 && code <= 9)) {
    return true;
  }
  if (codes.some((code) => code >= 30 && code <= 37)) {
    return true;
  }
  if (codes.some((code) => code >= 40 && code <= 47)) {
    return true;
  }
  if (codes.some((code) => code >= 90 && code <= 97)) {
    return true;
  }
  if (codes.some((code) => code >= 100 && code <= 107)) {
    return true;
  }
  if (codes.includes(38) || codes.includes(48)) {
    return true;
  }

  return active && !codes.every((code) => code === 22 || code === 23 || code === 24 || code === 27 || code === 29 || code === 39 || code === 49);
}
