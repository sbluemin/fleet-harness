import { parseConsoleReleaseNotes } from "./parser.js";
import { ConsoleReleaseNotesUnavailableError, type ConsoleReleaseNoteSection, type ConsoleReleaseNotes, type ConsoleReleaseNotesResponse, type LocalizedConsoleReleaseNotes, type ReleaseNotesLocale } from "./types.js";

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
