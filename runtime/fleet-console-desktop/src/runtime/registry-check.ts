import { readFile, writeFile } from "node:fs/promises";

export interface RegistryResponse {
  readonly ok: boolean;
  json(): Promise<unknown>;
}

export interface RegistryCheckFileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

export interface RegistryCheckDependencies {
  readonly fetch: (url: string, init: { signal: AbortSignal }) => Promise<RegistryResponse>;
  readonly fileSystem: RegistryCheckFileSystem;
  readonly setInterval: (callback: () => void, milliseconds: number) => ReturnType<typeof setInterval>;
  readonly clearInterval: (timer: ReturnType<typeof setInterval>) => void;
}

export interface RegistryCheckerOptions {
  readonly packageName: string;
  readonly statePath: string;
  readonly timeoutMilliseconds?: number;
  readonly pollIntervalMilliseconds?: number;
  readonly dependencies?: RegistryCheckDependencies;
}

export interface RegistryCheckResult {
  readonly latest: string | null;
  readonly shouldNotify: boolean;
  readonly unavailable?: boolean;
}

export interface RegistryChecker {
  check(currentVersion: string, manual?: boolean): Promise<RegistryCheckResult>;
  markPrompted?(version: string): void;
  skip(version: string): Promise<void>;
  startPolling(currentVersion: () => string, onUpdate: (version: string) => void): () => void;
}

interface RegistryState { readonly skipped: readonly string[]; }

const DEFAULT_TIMEOUT_MILLISECONDS = 3_000;
const DEFAULT_POLL_INTERVAL_MILLISECONDS = 60 * 60 * 1_000;

export function createRegistryChecker(options: RegistryCheckerOptions): RegistryChecker {
  const dependencies = options.dependencies ?? createRegistryCheckDependencies();
  const timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
  const pollIntervalMilliseconds = options.pollIntervalMilliseconds ?? DEFAULT_POLL_INTERVAL_MILLISECONDS;
  const prompted = new Set<string>();
  const check = async (currentVersion: string, manual = false): Promise<RegistryCheckResult> => {
    const fetched = await fetchLatest(options.packageName, timeoutMilliseconds, dependencies.fetch);
    // latest는 "설치 후보(현재보다 상위 버전)"일 때만 노출한다 — registry가 로컬 설치본보다
    // 뒤처진 경우(카나리 선행 등) 매 부팅 다운그레이드가 일어나는 것을 막는 가드.
    if (fetched.unavailable) return { latest: null, shouldNotify: false, unavailable: true };
    const latest = fetched.latest && isNewerVersion(fetched.latest, currentVersion) ? fetched.latest : null;
    if (!latest) return { latest, shouldNotify: false };
    if (manual) prompted.delete(latest);
    const state = await readState(options.statePath, dependencies.fileSystem);
    if (state.skipped.includes(latest) || prompted.has(latest)) return { latest, shouldNotify: false };
    return { latest, shouldNotify: true };
  };
  return {
    check,
    markPrompted(version) { prompted.add(version); },
    async skip(version) {
      const state = await readState(options.statePath, dependencies.fileSystem);
      await writeState(options.statePath, { skipped: unique([...state.skipped, version]) }, dependencies.fileSystem);
    },
    startPolling(currentVersion, onUpdate) {
      const poll = () => { void thisCheck(); };
      const thisCheck = async () => {
        const result = await check(currentVersion());
        if (result.shouldNotify && result.latest) onUpdate(result.latest);
      };
      const timer = dependencies.setInterval(poll, pollIntervalMilliseconds);
      return () => dependencies.clearInterval(timer);
    },
  };
}

export function createRegistryCheckDependencies(): RegistryCheckDependencies {
  return { fetch: async (url, init) => fetch(url, init), fileSystem: { readFile: async (target) => readFile(target, "utf8"), writeFile: async (target, content) => { await writeFile(target, content); } }, setInterval, clearInterval };
}

async function fetchLatest(packageName: string, timeoutMilliseconds: number, fetcher: RegistryCheckDependencies["fetch"]): Promise<{ readonly latest: string | null; readonly unavailable: boolean }> {
  try {
    const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, { signal: AbortSignal.timeout(timeoutMilliseconds) });
    if (!response.ok) return { latest: null, unavailable: true };
    const payload = await response.json();
    const latest = typeof payload === "object" && payload !== null && "dist-tags" in payload ? (payload["dist-tags"] as Record<string, unknown>).latest : undefined;
    return typeof latest === "string" ? { latest, unavailable: false } : { latest: null, unavailable: true };
  } catch {
    return { latest: null, unavailable: true };
  }
}

async function readState(statePath: string, fileSystem: RegistryCheckFileSystem): Promise<RegistryState> {
  try {
    const parsed = JSON.parse(await fileSystem.readFile(statePath)) as Partial<RegistryState>;
    return { skipped: Array.isArray(parsed.skipped) ? parsed.skipped.filter(isString) : [] };
  } catch {
    return { skipped: [] };
  }
}

async function writeState(statePath: string, state: RegistryState, fileSystem: RegistryCheckFileSystem): Promise<void> {
  await fileSystem.writeFile(statePath, JSON.stringify(state));
}

function unique(values: readonly string[]): string[] { return [...new Set(values)]; }

function isString(value: unknown): value is string { return typeof value === "string"; }

// dist-tags latest는 정식 릴리스(x.y.z) 관례를 따른다 — npm spec으로 해석될 수 있는 비정형 값은
// 비교 이전에 제거해 최초 설치의 alias·URL·range 주입을 막는다.
function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersionTriplet(candidate);
  if (!a) return false;
  if (!current) return true;
  const b = parseVersionTriplet(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

function parseVersionTriplet(version: string): readonly number[] | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
