import { execFile } from "node:child_process";
import type http from "node:http";

import { normalizeSystemFonts, type SystemFontFace } from "@fleet-console/font-picker/classify";
import type { SystemFontRecord, SystemFontsResponse } from "@fleet-console/font-picker/system-fonts";
import type { ApiCatalogEntry } from "@fleet-console/sdk/plugin";
import fontList from "font-list";

export interface SystemFontsService {
  getFonts(): Promise<readonly SystemFontRecord[]>;
}

export interface SystemFontsServiceDeps {
  readonly loadFonts?: () => Promise<readonly SystemFontFace[]>;
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

const SUCCESS_TTL_MS = 5 * 60 * 1000;
const FAILURE_TTL_MS = 30 * 1000;
const EMPTY_SYSTEM_FONTS_ERROR = new Error("system font enumeration returned no usable families");
/* fontconfig spacing: 0 proportional, 90 dual(CJK 고정폭처럼 반각·전각 두 폭), 100 mono, 110 charcell.
   font-list의 Linux 구현은 이 숫자를 'mono' 문자열로 찾고 이름 키워드에 기대며, family마다 첫 face
   하나만 남긴다 — Consolas가 코드 축에서 빠지고, 첫 face가 Bold이면 UI 축에서 빠진다. */
const FC_LIST_FORMAT = "%{family[0]}|%{style}|%{spacing}\\n";
const FC_MONOSPACE_MIN_SPACING = 90;
const FC_LIST_TIMEOUT_MS = 30_000;
const FC_LIST_MAX_BUFFER = 16 * 1024 * 1024;

export function createSystemFontsService(deps: SystemFontsServiceDeps = {}): SystemFontsService {
  const loadFonts = deps.loadFonts ?? (process.platform === "linux" ? loadFontconfigFaces : loadFontListFaces);
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

async function loadFontListFaces(): Promise<readonly SystemFontFace[]> {
  return fontList.getFonts2({ disableQuoting: true });
}

// fc-list가 없거나 실패하거나 아무것도 주지 않으면 font-list(fc-list2까지 찾는다)로 내려간다.
async function loadFontconfigFaces(): Promise<readonly SystemFontFace[]> {
  try {
    const faces = parseFcList(await runFcList());
    if (faces.length > 0) return faces;
  } catch {
    // 아래 폴백으로 간다.
  }
  return loadFontListFaces();
}

function runFcList(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("fc-list", ["-f", FC_LIST_FORMAT], { encoding: "utf8", timeout: FC_LIST_TIMEOUT_MS, maxBuffer: FC_LIST_MAX_BUFFER, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function parseFcList(output: string): readonly SystemFontFace[] {
  const faces: SystemFontFace[] = [];
  for (const line of output.split("\n")) {
    // family 이름에 '|'가 섞여도 뒤의 두 칸은 고정이므로 오른쪽에서 자른다.
    const spacingAt = line.lastIndexOf("|");
    const styleAt = spacingAt > 0 ? line.lastIndexOf("|", spacingAt - 1) : -1;
    if (styleAt <= 0) continue;
    const spacing = Number.parseInt(line.slice(spacingAt + 1), 10);
    faces.push({ familyName: line.slice(0, styleAt), style: line.slice(styleAt + 1, spacingAt), monospace: Number.isFinite(spacing) && spacing >= FC_MONOSPACE_MIN_SPACING });
  }
  return faces;
}

function buildSystemFontsResponse(fonts: readonly SystemFontRecord[]): SystemFontsResponse {
  return { version: 1, fonts };
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
