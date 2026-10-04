import type { SystemFontRecord } from "./system-fonts.js";

/**
 * 분류에 필요한 face 한 벌. 출처마다 모양이 다르다 — 호스트는 font-list나 fc-list로, 렌더러는
 * Local Font Access API로 face를 얻는다. 같은 휴리스틱을 거쳐야 두 목록의 축 필터가 같은 뜻이 된다.
 */
export interface SystemFontFace {
  readonly familyName: string;
  readonly style: string;
  readonly monospace: boolean;
}

const MAX_FAMILY_LENGTH = 128;
const CONTROL_CHARACTER_PATTERN = /[\x00-\x1F\x7F]/g;
const NORMAL_FACE_MARKERS = ["normal", "regular", "roman", "book"];
const TEXT_FAMILY_ALLOWLIST = new Set([
  "arial", "arial nova", "avenir", "avenir next", "calibri", "candara", "helvetica", "helvetica neue", "inter", "manrope", "noto sans", "noto serif", "segoe ui", "sf pro text", "system ui", "times new roman", "verdana",
  "apple sd gothic neo", "hiragino sans", "hiragino kaku gothic pro", "malgun gothic", "meiryo", "microsoft yahei", "noto sans cjk", "noto serif cjk", "pingfang sc", "pingfang tc", "yu gothic",
]);
const TEXT_FAMILY_MARKERS = ["sans", "serif", "text", "grotesk", "gothic", "roman", "book", "humanist"];
const DENY_FAMILY_MARKERS = ["hidden", "vertical", "symbol", "icon", "emoji", "dingbat", "ornament", "music", "math", "display", "decorative", "webdings", "wingdings", "marlett", "mdl2"];

export interface NormalizeSystemFontsOptions {
  /* 출처가 face의 style을 믿을 수 없을 때 켠다. Linux Chromium의 Local Font Access는 가변 서체의 모든
     인스턴스를 같은 style("Thin")로 보고한다. 그런 출처에서 family의 face가 모두 같은 style이면 그 이름은
     굵기에 대해 아무것도 말하지 않으므로 정상 face로 본다. 호스트 목록(fontconfig·OS)의 style은 믿는다. */
  readonly uniformStyleIsNormal?: boolean;
}

interface FontFamilyGroup {
  readonly family: string;
  readonly faces: readonly SystemFontFace[];
}

export function normalizeSystemFonts(fonts: readonly SystemFontFace[], options: NormalizeSystemFontsOptions = {}): readonly SystemFontRecord[] {
  const groups = new Map<string, { family: string; faces: SystemFontFace[] }>();
  for (const font of fonts) {
    if (!isSystemFontFace(font)) continue;
    const family = sanitizeFamilyName(font.familyName);
    if (!family) continue;
    const key = family.toLocaleLowerCase();
    const group = groups.get(key) ?? { family, faces: [] };
    group.faces.push(font);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => toSystemFontRecord(group, options))
    .sort((left, right) => left.family.localeCompare(right.family, undefined, { sensitivity: "base" }) || left.family.localeCompare(right.family));
}

function isSystemFontFace(value: unknown): value is SystemFontFace {
  return typeof value === "object" && value !== null && typeof (value as SystemFontFace).familyName === "string" && typeof (value as SystemFontFace).monospace === "boolean" && typeof (value as SystemFontFace).style === "string";
}

function sanitizeFamilyName(value: string): string {
  return value.replace(CONTROL_CHARACTER_PATTERN, "").trim().slice(0, MAX_FAMILY_LENGTH);
}

function toSystemFontRecord(group: FontFamilyGroup, options: NormalizeSystemFontsOptions): SystemFontRecord {
  const normalizedFamily = group.family.toLocaleLowerCase();
  const denied = DENY_FAMILY_MARKERS.some((marker) => normalizedFamily.includes(marker));
  // 기호 서체는 라틴 자리에 같은 폭의 그림을 두어 등폭으로 읽힌다. monospace는 곧 코드 축 후보라 함께 거른다.
  const monospace = !denied && group.faces.length > 0 && group.faces.every((face) => face.monospace);
  const proportionalFaces = group.faces.filter((face) => !face.monospace);
  const uniformStyle = proportionalFaces.length > 0 && proportionalFaces.every((face) => face.style === proportionalFaces[0]!.style);
  const hasNormalNonMonospaceFace = proportionalFaces.some(isNormalFace) || (options.uniformStyleIsNormal === true && uniformStyle);
  const textFamily = TEXT_FAMILY_ALLOWLIST.has(normalizedFamily) || TEXT_FAMILY_MARKERS.some((marker) => normalizedFamily.includes(marker));
  return { family: group.family, monospace, uiSuitable: !denied && hasNormalNonMonospaceFace && textFamily };
}

function isNormalFace(face: SystemFontFace): boolean {
  const style = face.style.toLocaleLowerCase();
  return NORMAL_FACE_MARKERS.some((marker) => style.includes(marker));
}
