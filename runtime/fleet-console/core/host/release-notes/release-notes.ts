export type ReleaseNoteProduct = "fleet-cli" | "fleet-console" | "fleet-desktop";

export interface ConsoleReleaseNoteItem {
  readonly packageTags: readonly string[];
  readonly text: string;
  readonly product?: ReleaseNoteProduct;
}

export interface ConsoleReleaseNoteSection {
  readonly heading: "Added" | "Changed" | "Fixed" | "Removed" | "Breaking Changes";
  readonly items: readonly ConsoleReleaseNoteItem[];
}

export interface ConsoleReleaseNotes {
  readonly version: string;
  readonly date: string | null;
  readonly sections: readonly ConsoleReleaseNoteSection[];
}

export interface LocalizedConsoleReleaseNotes extends ConsoleReleaseNotes {
  readonly localizationFallback: boolean;
}

export interface ConsoleReleaseNotesResponse {
  readonly notes: readonly LocalizedConsoleReleaseNotes[];
  readonly sourceRef: "main";
  readonly fetchedAt: number;
  readonly stale: boolean;
}

export type ReleaseNotesLocale = "en" | "ko";

export type ConsoleReleaseNotesUnavailableReason = "cold_unavailable" | "negative_cache";

export class ConsoleReleaseNotesUnavailableError extends Error {
  readonly reason: ConsoleReleaseNotesUnavailableReason;

  constructor(reason: ConsoleReleaseNotesUnavailableReason) {
    super("Console release notes are unavailable");
    this.name = "ConsoleReleaseNotesUnavailableError";
    this.reason = reason;
  }
}

type ReleaseNoteHeading = ConsoleReleaseNoteSection["heading"];

interface MutableReleaseNoteSection {
  readonly heading: ReleaseNoteHeading;
  readonly items: ConsoleReleaseNoteItem[];
}

// 지금 읽고 있는 항목이 어느 헤딩 아래 있는지. "retired"는 더 이상 노출하지 않는 옛 패키지 축 헤딩이고,
// "unknown"은 이 Console 버전이 알지 못하는 헤딩이다. 전자는 버리고 후자는 미분류로 보존한다.
type ProductScope = ReleaseNoteProduct | "retired" | "unknown" | "none";

const RELEASE_NOTE_HEADINGS: readonly ReleaseNoteHeading[] = ["Added", "Changed", "Fixed", "Removed", "Breaking Changes"];
const VERSION_HEADER_PATTERN = /^## \[([^\]]+)\](?: - ([0-9]{4}-[0-9]{2}-[0-9]{2}))?$/;
const SECTION_HEADER_PATTERN = /^### (Added|Changed|Fixed|Removed|Breaking Changes)$/;
const PRODUCT_HEADER_PATTERN = /^### (fleet-(?:cli|console|desktop))$/;
// v1.51.0까지의 이력은 구현 패키지 축으로 묶여 있어서 이 두 헤딩을 쓴다. 사용자가 체감하는 런타임이
// 아니므로 그 아래 항목은 노출하지 않는다. 헤딩 자체는 계속 알아본다 — 모르는 헤딩 취급으로 흘리면
// 아래에서 미분류 버킷으로 되살아나 결국 화면에 다시 나온다.
const RETIRED_PRODUCT_HEADER_PATTERN = /^### fleet-(?:plugin|core)$/;
const PRODUCT_SECTION_HEADER_PATTERN = /^#### (Added|Changed|Fixed|Removed|Breaking Changes)$/;
const BULLET_PATTERN = /^- (.+)$/;
const PACKAGE_TAG_PATTERN = /^\[([^\]]+)\]/;

export function parseConsoleReleaseNotes(changelog: string): readonly ConsoleReleaseNotes[] {
  const lines = changelog.split(/\r?\n/);
  const notes: ConsoleReleaseNotes[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = VERSION_HEADER_PATTERN.exec(lines[index] ?? "");
    if (match === null) continue;
    const block: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if ((lines[cursor] ?? "").startsWith("## ")) break;
      block.push(lines[cursor] ?? "");
    }
    const sections = collectSections(block);
    if (sections.length === 0) continue;
    notes.push({ version: match[1] ?? "", date: match[2] ?? null, sections });
  }
  return notes;
}

// 이 리더는 컴파일러보다 넓게 읽는다. 컴파일된 이력은 다시 쓰지 않으므로, 읽는 쪽이 지금까지 쓰인 모든
// 방언과 앞으로 추가될 런타임 헤딩을 모두 받아내야 한다. 알아보지 못한 입력을 버리면 사용자는 오류 없이
// 항목을 잃는다.
function collectSections(lines: readonly string[]): readonly ConsoleReleaseNoteSection[] {
  const legacySections = new Map<ReleaseNoteHeading, MutableReleaseNoteSection>();
  const productSections = new Map<ReleaseNoteHeading, MutableReleaseNoteSection>();
  let current: MutableReleaseNoteSection | null = null;
  let scope: ProductScope = "none";
  for (const line of lines) {
    const sectionMatch = SECTION_HEADER_PATTERN.exec(line);
    if (sectionMatch !== null) {
      // 같은 섹션 헤딩이 한 릴리스에 두 번 나오면 이어 붙인다. 첫 블록만 남기면 v1.3.0처럼 뒤 블록의
      // 항목이 조용히 사라진다.
      scope = "none";
      current = getSection(legacySections, sectionMatch[1] as ReleaseNoteHeading);
      continue;
    }
    const productMatch = PRODUCT_HEADER_PATTERN.exec(line);
    if (productMatch !== null) {
      scope = productMatch[1] as ReleaseNoteProduct;
      current = null;
      continue;
    }
    if (RETIRED_PRODUCT_HEADER_PATTERN.test(line)) {
      scope = "retired";
      current = null;
      continue;
    }
    if (line.startsWith("### ")) {
      // 이 리더가 모르는 제품 헤딩이다. 배포된 Console은 갱신할 수 없으므로 미래에 추가되는 런타임의
      // 항목도 버리지 않고 미분류 버킷으로 흘린다.
      scope = "unknown";
      current = null;
      continue;
    }
    const productSectionMatch = PRODUCT_SECTION_HEADER_PATTERN.exec(line);
    if (productSectionMatch !== null) {
      const heading = productSectionMatch[1] as ReleaseNoteHeading;
      if (isSupportedProduct(scope)) current = getSection(productSections, heading);
      else if (scope === "unknown") current = getSection(legacySections, heading);
      else current = null;
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("### ") || line.startsWith("#### ")) {
      current = null;
      continue;
    }
    const bulletMatch = BULLET_PATTERN.exec(line);
    if (bulletMatch !== null) current.items.push(parseReleaseNoteItem(bulletMatch[1] ?? "", isSupportedProduct(scope) ? scope : null));
  }
  return RELEASE_NOTE_HEADINGS
    .map((heading) => combineSections(heading, legacySections.get(heading), productSections.get(heading)))
    .filter((section): section is MutableReleaseNoteSection => Boolean(section && section.items.length > 0));
}

function combineSections(
  heading: ReleaseNoteHeading,
  legacySection: MutableReleaseNoteSection | undefined,
  productSection: MutableReleaseNoteSection | undefined,
): MutableReleaseNoteSection | undefined {
  if (legacySection === undefined && productSection === undefined) return undefined;
  return { heading, items: [...(legacySection?.items ?? []), ...(productSection?.items ?? [])] };
}

function isSupportedProduct(scope: ProductScope): scope is ReleaseNoteProduct {
  return scope !== "none" && scope !== "retired" && scope !== "unknown";
}

function getSection(
  sections: Map<ReleaseNoteHeading, MutableReleaseNoteSection>,
  heading: ReleaseNoteHeading,
): MutableReleaseNoteSection {
  const existing = sections.get(heading);
  if (existing !== undefined) return existing;
  const section = { heading, items: [] };
  sections.set(heading, section);
  return section;
}

function parseReleaseNoteItem(rawText: string, product: ReleaseNoteProduct | null): ConsoleReleaseNoteItem {
  const packageTags: string[] = [];
  let text = rawText.trim();
  while (true) {
    const match = PACKAGE_TAG_PATTERN.exec(text);
    if (match === null) break;
    packageTags.push(match[1] ?? "");
    text = text.slice(match[0].length).trimStart();
  }
  return product === null ? { packageTags, text: text.trim() } : { packageTags, text: text.trim(), product };
}

interface ConsoleReleaseNotesServiceDeps {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

export interface ConsoleReleaseNotesRefreshOptions {
  readonly force?: boolean;
  readonly locale?: ReleaseNotesLocale;
}

export interface ConsoleReleaseNotesService {
  refresh(options?: ConsoleReleaseNotesRefreshOptions): Promise<ConsoleReleaseNotesResponse>;
}

interface KoreanReleaseNotesDocument {
  readonly notes: readonly LocalizedConsoleReleaseNotes[];
  readonly fetchedAt: number;
}

const RAW_CHANGELOG_URL = "https://raw.githubusercontent.com/sbluemin/fleet-harness/main/CHANGELOG.md";
const RAW_KOREAN_CHANGELOG_URL = "https://raw.githubusercontent.com/sbluemin/fleet-harness/main/CHANGELOG.ko.md";
const SOURCE_REF = "main";
const FETCH_TIMEOUT_MS = 3_000;
const MAX_CHANGELOG_BYTES = 1024 * 1024;
const SUCCESS_TTL_MS = 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;

export function createConsoleReleaseNotesService(deps: ConsoleReleaseNotesServiceDeps = {}): ConsoleReleaseNotesService {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimeout ?? setTimeout;
  const clearTimer = deps.clearTimeout ?? clearTimeout;
  let lastSuccess: ConsoleReleaseNotesResponse | null = null;
  let lastFailureAt = 0;
  let inFlight: Promise<ConsoleReleaseNotesResponse> | null = null;
  let forceInFlight: Promise<ConsoleReleaseNotesResponse> | null = null;
  let koreanLastSuccess: KoreanReleaseNotesDocument | null = null;
  let koreanLastFailureAt = 0;
  let koreanInFlight: Promise<KoreanReleaseNotesDocument | null> | null = null;
  let koreanForceInFlight: Promise<KoreanReleaseNotesDocument | null> | null = null;
  let koreanRequestGeneration = 0;

  async function refresh(options: ConsoleReleaseNotesRefreshOptions = {}): Promise<ConsoleReleaseNotesResponse> {
    if (options.locale === "ko") return await refreshKoreanOverlay(options);
    return await refreshEnglish(options);
  }

  async function refreshEnglish(options: ConsoleReleaseNotesRefreshOptions): Promise<ConsoleReleaseNotesResponse> {
    const currentTime = now();
    if (options.force) {
      if (forceInFlight) return await forceInFlight;
      const pending = runFetch().finally(() => {
        if (forceInFlight === pending) forceInFlight = null;
      });
      forceInFlight = pending;
      return await pending;
    }
    if (lastSuccess && currentTime - lastSuccess.fetchedAt < SUCCESS_TTL_MS) return lastSuccess;
    if (lastFailureAt > 0 && currentTime - lastFailureAt < NEGATIVE_TTL_MS) {
      if (lastSuccess) return { ...lastSuccess, stale: true };
      throw new ConsoleReleaseNotesUnavailableError("negative_cache");
    }
    if (inFlight) return await inFlight;
    const pending = runFetch().finally(() => {
      if (inFlight === pending) inFlight = null;
    });
    inFlight = pending;
    return await pending;
  }

  async function refreshKoreanOverlay(options: ConsoleReleaseNotesRefreshOptions): Promise<ConsoleReleaseNotesResponse> {
    // 한국어 fetch는 영어 성공/실패 판정과 독립적으로 시작하며 어떤 실패도 public 상태로 승격하지 않는다.
    const english = refreshEnglish(options);
    const korean = refreshKorean(options).catch(() => null);
    const canonical = await english;
    const localized = await korean;
    return mergeKoreanOverlay(canonical, localized?.notes ?? null);
  }

  function runFetch(): Promise<ConsoleReleaseNotesResponse> {
    return fetchEnglishReleaseNotes()
      .then((result) => {
        lastSuccess = result;
        lastFailureAt = 0;
        return result;
      })
      .catch((error: unknown) => {
        lastFailureAt = now();
        if (lastSuccess) return { ...lastSuccess, stale: true };
        if (error instanceof ConsoleReleaseNotesUnavailableError) throw error;
        throw new ConsoleReleaseNotesUnavailableError("cold_unavailable");
      });
  }

  async function fetchEnglishReleaseNotes(): Promise<ConsoleReleaseNotesResponse> {
    return {
      notes: await fetchAndParse(RAW_CHANGELOG_URL),
      sourceRef: SOURCE_REF,
      fetchedAt: now(),
      stale: false,
    };
  }

  async function refreshKorean(options: ConsoleReleaseNotesRefreshOptions): Promise<KoreanReleaseNotesDocument | null> {
    const currentTime = now();
    if (options.force) {
      if (koreanForceInFlight) return await koreanForceInFlight;
      const pending = runKoreanFetch(++koreanRequestGeneration).finally(() => {
        if (koreanForceInFlight === pending) koreanForceInFlight = null;
      });
      koreanForceInFlight = pending;
      return await pending;
    }
    if (koreanLastSuccess && currentTime - koreanLastSuccess.fetchedAt < SUCCESS_TTL_MS) return koreanLastSuccess;
    if (koreanLastFailureAt > 0 && currentTime - koreanLastFailureAt < NEGATIVE_TTL_MS) return null;
    if (koreanInFlight) return await koreanInFlight;
    const pending = runKoreanFetch(++koreanRequestGeneration).finally(() => {
      if (koreanInFlight === pending) koreanInFlight = null;
    });
    koreanInFlight = pending;
    return await pending;
  }

  function runKoreanFetch(requestGeneration: number): Promise<KoreanReleaseNotesDocument | null> {
    return fetchAndParse(RAW_KOREAN_CHANGELOG_URL)
      .then((notes) => {
        const result = { notes, fetchedAt: now() };
        if (requestGeneration === koreanRequestGeneration) {
          koreanLastSuccess = result;
          koreanLastFailureAt = 0;
        }
        return result;
      })
      .catch(() => {
        if (requestGeneration === koreanRequestGeneration) koreanLastFailureAt = now();
        return null;
      });
  }

  async function fetchAndParse(url: string): Promise<readonly LocalizedConsoleReleaseNotes[]> {
    const controller = new AbortController();
    const timer = setTimer(() => controller.abort(), FETCH_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: "text/plain; charset=utf-8" },
        signal: controller.signal,
      });
      if (!response.ok) throw new ConsoleReleaseNotesUnavailableError("cold_unavailable");
      const text = await readTextWithByteLimit(response, controller);
      return parseConsoleReleaseNotes(text).map((note) => ({ ...note, localizationFallback: false }));
    } finally {
      clearTimer(timer);
    }
  }

  return { refresh };
}

function mergeKoreanOverlay(canonical: ConsoleReleaseNotesResponse, koreanNotes: readonly LocalizedConsoleReleaseNotes[] | null): ConsoleReleaseNotesResponse {
  if (koreanNotes === null) return { ...canonical, notes: canonical.notes.map(withFallback) };
  const occurrences = new Map<string, LocalizedConsoleReleaseNotes[]>();
  for (const note of koreanNotes) {
    const queue = occurrences.get(note.version) ?? [];
    queue.push(note);
    occurrences.set(note.version, queue);
  }
  return {
    ...canonical,
    notes: canonical.notes.map((english) => {
      const korean = occurrences.get(english.version)?.shift();
      return korean && hasMatchingStructure(english, korean)
        ? { ...english, sections: overlayLocalizedText(english.sections, korean.sections), localizationFallback: false }
        : withFallback(english);
    }),
  };
}

function withFallback(note: LocalizedConsoleReleaseNotes): LocalizedConsoleReleaseNotes {
  return { ...note, localizationFallback: true };
}

function hasMatchingStructure(english: ConsoleReleaseNotes, korean: ConsoleReleaseNotes): boolean {
  return english.date === korean.date
    && english.sections.length === korean.sections.length
    && english.sections.every((section, sectionIndex) => {
      const localizedSection = korean.sections[sectionIndex];
      return localizedSection?.heading === section.heading
        && localizedSection.items.length === section.items.length
        && section.items.every((item, itemIndex) => {
          const localizedItem = localizedSection.items[itemIndex];
          return sameTags(item.packageTags, localizedItem?.packageTags) && item.product === localizedItem?.product;
        });
    });
}

function overlayLocalizedText(
  englishSections: readonly ConsoleReleaseNoteSection[],
  koreanSections: readonly ConsoleReleaseNoteSection[],
): readonly ConsoleReleaseNoteSection[] {
  return englishSections.map((section, sectionIndex) => ({
    ...section,
    items: section.items.map((item, itemIndex) => ({
      ...item,
      text: koreanSections[sectionIndex]!.items[itemIndex]!.text,
    })),
  }));
}

function sameTags(left: readonly string[], right: readonly string[] | undefined): boolean {
  if (right === undefined) return false;
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

async function readTextWithByteLimit(response: Response, controller: AbortController): Promise<string> {
  const body = response.body;
  if (body === null) return await response.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_CHANGELOG_BYTES) {
        controller.abort();
        throw new ConsoleReleaseNotesUnavailableError("cold_unavailable");
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(joinChunks(chunks, totalBytes));
  } finally {
    reader.releaseLock();
  }
}

function joinChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}
