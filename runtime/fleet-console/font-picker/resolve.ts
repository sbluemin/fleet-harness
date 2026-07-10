export interface FontResolutionOptions {
  readonly document?: Document;
  readonly maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 200;
const FONT_RESOLVE_THRESHOLD_PX = 0.5;
const FONT_RESOLVE_PROBE = "mmmmmmmmmmwwwwiIl1 0O-_|┌ABCxyz";
const GENERIC_FAMILIES = ["monospace", "serif", "sans-serif"] as const;
const resolutionCache = new Map<string, boolean>();

export function fontResolves(familyName: string, options: FontResolutionOptions = {}): boolean {
  const family = sanitizeFontFamilyName(familyName);
  if (!family) return false;
  const cacheKey = family.toLocaleLowerCase();
  const cached = resolutionCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const documentRef = options.document ?? globalThis.document;
  if (!documentRef) return false;
  const context = documentRef.createElement("canvas").getContext("2d");
  if (!context) return false;
  const resolved = GENERIC_FAMILIES.some((generic) => {
    const candidateWidth = measureFontWidth(context, `${quoteFontFamily(family)}, ${generic}`);
    const genericWidth = measureFontWidth(context, generic);
    return Math.abs(candidateWidth - genericWidth) > FONT_RESOLVE_THRESHOLD_PX;
  });
  rememberResolution(cacheKey, resolved, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  return resolved;
}

export function quoteFontFamily(familyName: string): string {
  return `"${familyName.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

export function withFontFallback(familyName: string, fallbackStack: string): string {
  const family = sanitizeFontFamilyName(familyName);
  return family ? `${quoteFontFamily(family)}, ${fallbackStack}` : fallbackStack;
}

export function sanitizeFontFamilyName(familyName: string): string {
  return familyName.replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, 128);
}

export function clearFontResolutionCache(): void {
  resolutionCache.clear();
}

function measureFontWidth(context: CanvasRenderingContext2D, family: string): number {
  context.font = `28px ${family}`;
  return context.measureText(FONT_RESOLVE_PROBE).width;
}

function rememberResolution(key: string, value: boolean, maxEntries: number): void {
  if (resolutionCache.size >= Math.max(1, maxEntries)) {
    const oldestKey = resolutionCache.keys().next().value;
    if (oldestKey) resolutionCache.delete(oldestKey);
  }
  resolutionCache.set(key, value);
}
