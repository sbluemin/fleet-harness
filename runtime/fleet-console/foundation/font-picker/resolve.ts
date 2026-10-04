export interface FontResolutionOptions {
  readonly document?: Document;
  readonly maxEntries?: number;
}

/* 커버리지 판정의 기준선이 될 서체. 이 인자를 소비자가 지정하는 이유는 기본 기준선(존재하지 않는
   서체명 → OS 기본 폴백)이 한 부류를 통째로 오판하기 때문이다: 후보가 마침 그 스크립트의 OS 폴백
   서체 자체이면(macOS 한글의 Apple SD Gothic Neo처럼) 후보 렌더와 기준선 렌더가 같아져 "글리프
   없음"으로 읽힌다. 소비자가 자기 번들 서체를 기준선으로 넘기면 그 오판이 번들 서체 자신 한 종으로
   좁혀지고, 그 한 종은 어차피 내장 항목으로 이미 제공된다. */
export interface FontCoverageOptions extends FontResolutionOptions {
  readonly baselineFamily?: string;
  /* 이 판정을 기억해도 되는지. 기준선 서체가 아직 준비되지 않은 채 물었다면 그 답은 기준선이 OS
     폴백으로 주저앉은 상태의 답이라, 기억하는 순간 한 번의 오답이 세션 내내 남는다. 읽기는 막지
     않는다 — 캐시에는 신뢰할 수 있는 판정만 들어가기 때문이다. */
  readonly cache?: boolean;
}

const DEFAULT_MAX_ENTRIES = 200;
const FONT_RESOLVE_THRESHOLD_PX = 0.5;
const FONT_RESOLVE_PROBE = "mmmmmmmmmmwwwwiIl1 0O-_|┌ABCxyz";
const GENERIC_FAMILIES = ["monospace", "serif", "sans-serif"] as const;
const COVERAGE_ABSENT_SENTINEL = "fleet font probe absent";
const COVERAGE_PROBE_FONT_SIZE = 24;
const COVERAGE_CANVAS_WIDTH = 128;
const COVERAGE_CANVAS_HEIGHT = 40;
const COVERAGE_PROBE_ORIGIN_X = 2;
const COVERAGE_PROBE_ORIGIN_Y = 30;
const resolutionCache = new Map<string, boolean>();
const coverageCache = new Map<string, boolean>();
const baselineRasterCache = new Map<string, Uint8ClampedArray>();

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

/* 이 서체가 이 글자를 직접 그리는가. 폭 비교로는 답할 수 없다 — 캔버스는 글리프가 없는 서체에도
   폴백을 적용해 무언가를 그려내므로 tofu가 보이지 않고, CJK는 대부분 서체가 같은 전각 advance를
   쓰기 때문에 폭이 우연히 일치한다. 그래서 래스터를 통째로 비교한다: 후보 체인과 기준선 체인이
   같은 픽셀을 그렸다면 후보는 이 글자를 폴백에 넘긴 것이다. 안티에일리어싱은 같은 서체·같은 좌표
   에서 결정적이라 정확 비교로 충분하다. */
export function fontDrawsText(familyName: string, probeText: string, options: FontCoverageOptions = {}): boolean {
  const family = sanitizeFontFamilyName(familyName);
  const probe = probeText.trim();
  if (!family || !probe) return false;
  const baselineFamily = sanitizeFontFamilyName(options.baselineFamily ?? "") || COVERAGE_ABSENT_SENTINEL;
  const cacheKey = `${family.toLocaleLowerCase()}\u0000${probe}\u0000${baselineFamily.toLocaleLowerCase()}`;
  const cached = coverageCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const documentRef = options.document ?? globalThis.document;
  if (!documentRef) return false;
  const context = createCoverageContext(documentRef);
  if (!context) return false;
  const rememberable = options.cache ?? true;
  const baselineStack = quoteFontFamily(baselineFamily);
  // 기준선은 후보와 무관하므로 한 번만 그린다 — 설치 서체 전량을 훑을 때 래스터화가 절반으로 준다.
  // 신뢰할 수 없는 판정의 기준선 래스터를 남기면 그 오염이 이후의 신뢰할 수 있는 호출까지 번진다.
  const baselineKey = `${probe}\u0000${baselineFamily.toLocaleLowerCase()}`;
  const baseline = baselineRasterCache.get(baselineKey) ?? rasterizeProbe(context, baselineStack, probe);
  if (baseline !== null && rememberable) baselineRasterCache.set(baselineKey, baseline);
  const candidate = rasterizeProbe(context, `${quoteFontFamily(family)}, ${baselineStack}`, probe);
  // 래스터를 못 읽으면(테인트·미지원) 판정을 만들지 않는다 — 캐시에도 남기지 않아 다음에 다시 묻는다.
  if (baseline === null || candidate === null) return false;
  const covered = !rastersMatch(baseline, candidate);
  if (rememberable) rememberCoverage(cacheKey, covered, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  return covered;
}

/* "없음" 판정만 잊는다. 있는 서체가 세션 중에 사라지는 일은 드물지만, 화면을 열어 둔 채 서체를
   설치하는 일은 흔하다 — 거짓을 계속 기억하면 그 서체는 새로고침 전까지 사용 불가로 남는다. */
export function forgetUnresolvedFonts(): void {
  for (const [key, resolved] of resolutionCache) {
    if (!resolved) resolutionCache.delete(key);
  }
}

export function clearFontResolutionCache(): void {
  resolutionCache.clear();
  coverageCache.clear();
  baselineRasterCache.clear();
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

function createCoverageContext(documentRef: Document): CanvasRenderingContext2D | null {
  const canvas = documentRef.createElement("canvas");
  canvas.width = COVERAGE_CANVAS_WIDTH;
  canvas.height = COVERAGE_CANVAS_HEIGHT;
  // 같은 캔버스를 두 번 읽으므로 willReadFrequently로 GPU 왕복을 피한다.
  return canvas.getContext("2d", { willReadFrequently: true });
}

function rasterizeProbe(context: CanvasRenderingContext2D, fontStack: string, probe: string): Uint8ClampedArray | null {
  context.clearRect(0, 0, COVERAGE_CANVAS_WIDTH, COVERAGE_CANVAS_HEIGHT);
  context.font = `${COVERAGE_PROBE_FONT_SIZE}px ${fontStack}`;
  context.textBaseline = "alphabetic";
  context.fillStyle = "#000000";
  context.fillText(probe, COVERAGE_PROBE_ORIGIN_X, COVERAGE_PROBE_ORIGIN_Y);
  try {
    return context.getImageData(0, 0, COVERAGE_CANVAS_WIDTH, COVERAGE_CANVAS_HEIGHT).data;
  } catch {
    return null;
  }
}

function rastersMatch(left: Uint8ClampedArray, right: Uint8ClampedArray): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function rememberCoverage(key: string, value: boolean, maxEntries: number): void {
  if (coverageCache.size >= Math.max(1, maxEntries)) {
    const oldestKey = coverageCache.keys().next().value;
    if (oldestKey) coverageCache.delete(oldestKey);
  }
  coverageCache.set(key, value);
}
