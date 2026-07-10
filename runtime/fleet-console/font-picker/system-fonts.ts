export interface SystemFontRecord {
  readonly family: string;
  readonly monospace: boolean;
  readonly uiSuitable: boolean;
}

export interface SystemFontsResponse {
  readonly version: 1;
  readonly fonts: readonly SystemFontRecord[];
}

export interface FetchSystemFontsOptions {
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

const SYSTEM_FONTS_PATH = "/api/v1/settings/fonts/system";

export class SystemFontsFetchError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "SystemFontsFetchError";
    this.status = status;
  }
}

export function parseSystemFontsResponse(value: unknown): SystemFontsResponse {
  if (!hasExactKeys(value, ["version", "fonts"]) || value.version !== 1 || !Array.isArray(value.fonts)) {
    throw new SystemFontsFetchError("System font response has an unsupported shape.");
  }
  const fonts = value.fonts.map(parseSystemFontRecord);
  return { version: 1, fonts };
}

export async function fetchSystemFonts(options: FetchSystemFontsOptions = {}): Promise<SystemFontsResponse> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new SystemFontsFetchError("System font fetching is unavailable in this environment.");
  }
  let response: Response;
  try {
    response = await fetchImpl(SYSTEM_FONTS_PATH, { method: "GET", signal: options.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new SystemFontsFetchError("System fonts could not be loaded.");
  }
  if (!response.ok) {
    throw new SystemFontsFetchError("System fonts could not be loaded.", response.status);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new SystemFontsFetchError("System font response is not valid JSON.", response.status);
  }
  return parseSystemFontsResponse(payload);
}

function parseSystemFontRecord(value: unknown): SystemFontRecord {
  if (!hasExactKeys(value, ["family", "monospace", "uiSuitable"]) || typeof value.family !== "string" || !value.family.trim() || typeof value.monospace !== "boolean" || typeof value.uiSuitable !== "boolean") {
    throw new SystemFontsFetchError("System font response contains an invalid record.");
  }
  return { family: value.family, monospace: value.monospace, uiSuitable: value.uiSuitable };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
