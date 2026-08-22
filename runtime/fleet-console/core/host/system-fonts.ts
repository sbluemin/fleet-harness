import type http from "node:http";

import type { ApiCatalogEntry } from "@fleet-console/sdk/plugin";
import fontList, { type IFontInfo } from "font-list";

export interface SystemFontRecord {
  readonly family: string;
  readonly monospace: boolean;
  readonly uiSuitable: boolean;
}

export interface SystemFontsResponse {
  readonly version: 1;
  readonly fonts: readonly SystemFontRecord[];
}

export interface SystemFontsService {
  getFonts(): Promise<readonly SystemFontRecord[]>;
}

export interface SystemFontsServiceDeps {
  readonly loadFonts?: () => Promise<readonly IFontInfo[]>;
  readonly now?: () => number;
  readonly successTtlMs?: number;
  readonly failureTtlMs?: number;
}

interface CachedSystemFonts {
  readonly fonts: readonly SystemFontRecord[];
  readonly cachedAt: number;
}

interface CachedSystemFontsFailure {
  readonly error: unknown;
  readonly cachedAt: number;
}

interface FontFamilyGroup {
  readonly family: string;
  readonly faces: readonly IFontInfo[];
}

const MAX_FAMILY_LENGTH = 128;
const SUCCESS_TTL_MS = 5 * 60 * 1000;
const FAILURE_TTL_MS = 30 * 1000;
const CONTROL_CHARACTER_PATTERN = /[\x00-\x1F\x7F]/g;
const NORMAL_FACE_MARKERS = ["normal", "regular", "roman", "book"];
const TEXT_FAMILY_ALLOWLIST = new Set([
  "arial", "arial nova", "avenir", "avenir next", "calibri", "candara", "helvetica", "helvetica neue", "inter", "manrope", "noto sans", "noto serif", "segoe ui", "sf pro text", "system ui", "times new roman", "verdana",
  "apple sd gothic neo", "hiragino sans", "hiragino kaku gothic pro", "malgun gothic", "meiryo", "microsoft yahei", "noto sans cjk", "noto serif cjk", "pingfang sc", "pingfang tc", "yu gothic",
]);
const TEXT_FAMILY_MARKERS = ["sans", "serif", "text", "grotesk", "gothic", "roman", "book", "humanist"];
const DENY_FAMILY_MARKERS = ["hidden", "vertical", "symbol", "icon", "emoji", "dingbat", "ornament", "music", "math", "display", "decorative"];
const EMPTY_SYSTEM_FONTS_ERROR = new Error("system font enumeration returned no usable families");

export function createSystemFontsService(deps: SystemFontsServiceDeps = {}): SystemFontsService {
  const loadFonts = deps.loadFonts ?? (() => fontList.getFonts2({ disableQuoting: true }));
  const now = deps.now ?? Date.now;
  const successTtlMs = deps.successTtlMs ?? SUCCESS_TTL_MS;
  const failureTtlMs = deps.failureTtlMs ?? FAILURE_TTL_MS;
  let cached: CachedSystemFonts | null = null;
  let cachedFailure: CachedSystemFontsFailure | null = null;
  let inFlight: Promise<readonly SystemFontRecord[]> | null = null;

  const getFonts = (): Promise<readonly SystemFontRecord[]> => {
    if (cached && now() - cached.cachedAt < successTtlMs) return Promise.resolve(cached.fonts);
    if (cachedFailure && now() - cachedFailure.cachedAt < failureTtlMs) return Promise.reject(cachedFailure.error);
    if (inFlight) return inFlight;
    inFlight = loadFonts()
      .then((fonts) => {
        const normalized = normalizeSystemFonts(fonts);
        if (normalized.length === 0) throw EMPTY_SYSTEM_FONTS_ERROR;
        cached = { fonts: normalized, cachedAt: now() };
        cachedFailure = null;
        return normalized;
      })
      .catch((error: unknown) => {
        cachedFailure = { error, cachedAt: now() };
        throw error;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return { getFonts };
}

export function normalizeSystemFonts(fonts: readonly IFontInfo[]): readonly SystemFontRecord[] {
  const groups = new Map<string, { family: string; faces: IFontInfo[] }>();
  for (const font of fonts) {
    if (!isFontInfo(font)) continue;
    const family = sanitizeFamilyName(font.familyName);
    if (!family) continue;
    const key = family.toLocaleLowerCase();
    const group = groups.get(key) ?? { family, faces: [] };
    group.faces.push(font);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(toSystemFontRecord)
    .sort((left, right) => left.family.localeCompare(right.family, undefined, { sensitivity: "base" }) || left.family.localeCompare(right.family));
}

function buildSystemFontsResponse(fonts: readonly SystemFontRecord[]): SystemFontsResponse {
  return { version: 1, fonts };
}

function isFontInfo(value: unknown): value is IFontInfo {
  return typeof value === "object" && value !== null && typeof (value as IFontInfo).familyName === "string" && typeof (value as IFontInfo).monospace === "boolean" && typeof (value as IFontInfo).style === "string";
}

function sanitizeFamilyName(value: string): string {
  return value.replace(CONTROL_CHARACTER_PATTERN, "").trim().slice(0, MAX_FAMILY_LENGTH);
}

function toSystemFontRecord(group: FontFamilyGroup): SystemFontRecord {
  const normalizedFamily = group.family.toLocaleLowerCase();
  const monospace = group.faces.length > 0 && group.faces.every((face) => face.monospace);
  const hasNormalNonMonospaceFace = group.faces.some((face) => !face.monospace && isNormalFace(face));
  const denied = DENY_FAMILY_MARKERS.some((marker) => normalizedFamily.includes(marker));
  const textFamily = TEXT_FAMILY_ALLOWLIST.has(normalizedFamily) || TEXT_FAMILY_MARKERS.some((marker) => normalizedFamily.includes(marker));
  return { family: group.family, monospace, uiSuitable: !denied && hasNormalNonMonospaceFace && textFamily };
}

function isNormalFace(face: IFontInfo): boolean {
  const style = face.style.toLocaleLowerCase();
  return NORMAL_FACE_MARKERS.some((marker) => style.includes(marker));
}

export interface SystemFontsRouteDeps {
  readonly systemFonts: SystemFontsService;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
}

export interface SystemFontsRouteContext {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly pathname: string;
}

const SYSTEM_FONTS_PATH = "/api/v1/settings/fonts/system";

export const SYSTEM_FONTS_API_CATALOG: readonly ApiCatalogEntry[] = [
  {
    method: "GET",
    path: SYSTEM_FONTS_PATH,
    summary: "List sanitized system font families for built-in settings.",
    category: "Settings",
    gate: "loopback",
    transport: "http",
  },
];

export function createSystemFontsRouter(deps: SystemFontsRouteDeps): (context: SystemFontsRouteContext) => Promise<boolean> {
  return async function handleSystemFontsRoute(context: SystemFontsRouteContext): Promise<boolean> {
    if (context.pathname !== SYSTEM_FONTS_PATH) return false;
    if (context.req.method !== "GET") {
      deps.writeJson(context.res, 405, { error: "Method not allowed" });
      return true;
    }
    try {
      deps.writeJson(context.res, 200, buildSystemFontsResponse(await deps.systemFonts.getFonts()));
    } catch {
      deps.writeJson(context.res, 503, { error: "system_fonts_unavailable" });
    }
    return true;
  };
}
