import { parseConsoleReleaseNotes } from "./parser.js";
import { ConsoleReleaseNotesUnavailableError, type ConsoleReleaseNotesResponse } from "./types.js";

interface ConsoleReleaseNotesServiceDeps {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

export interface ConsoleReleaseNotesRefreshOptions {
  readonly force?: boolean;
}

export interface ConsoleReleaseNotesService {
  refresh(options?: ConsoleReleaseNotesRefreshOptions): Promise<ConsoleReleaseNotesResponse>;
}

const RAW_CHANGELOG_URL = "https://raw.githubusercontent.com/sbluemin/fleet-harness/main/CHANGELOG.md";
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

  async function refresh(options: ConsoleReleaseNotesRefreshOptions = {}): Promise<ConsoleReleaseNotesResponse> {
    const currentTime = now();
    // 강제 요청은 성공/negative 캐시와 일반 in-flight를 우회해 항상 새 fetch를 시작하되, 강제 요청끼리는 합친다.
    if (options.force) {
      if (forceInFlight) return forceInFlight;
      const pending = runFetch().finally(() => {
        if (forceInFlight === pending) forceInFlight = null;
      });
      forceInFlight = pending;
      return pending;
    }
    // 성공 TTL 내에는 캐시를 그대로 반환한다.
    if (lastSuccess && currentTime - lastSuccess.fetchedAt < SUCCESS_TTL_MS) return lastSuccess;
    // 최근 실패 직후 negative TTL 동안에는 외부 호출 없이, 성공 이력이 있으면 stale을 없으면 오류를 반환한다.
    if (lastFailureAt > 0 && currentTime - lastFailureAt < NEGATIVE_TTL_MS) {
      if (lastSuccess) return { ...lastSuccess, stale: true };
      throw new ConsoleReleaseNotesUnavailableError("negative_cache");
    }
    if (inFlight) return inFlight;
    const pending = runFetch().finally(() => {
      if (inFlight === pending) inFlight = null;
    });
    inFlight = pending;
    return pending;
  }

  function runFetch(): Promise<ConsoleReleaseNotesResponse> {
    return fetchReleaseNotes()
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

  async function fetchReleaseNotes(): Promise<ConsoleReleaseNotesResponse> {
    const controller = new AbortController();
    const timer = setTimer(() => controller.abort(), FETCH_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await fetchImpl(RAW_CHANGELOG_URL, {
        headers: { Accept: "text/plain; charset=utf-8" },
        signal: controller.signal,
      });
      if (!response.ok) throw new ConsoleReleaseNotesUnavailableError("cold_unavailable");
      const text = await readTextWithByteLimit(response, controller);
      return {
        notes: parseConsoleReleaseNotes(text),
        sourceRef: SOURCE_REF,
        fetchedAt: now(),
        stale: false,
      };
    } finally {
      clearTimer(timer);
    }
  }

  return { refresh };
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
