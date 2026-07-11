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
}

export interface RegistryChecker {
  check(currentVersion: string): Promise<RegistryCheckResult>;
  skip(version: string): Promise<void>;
  startPolling(currentVersion: () => string, onUpdate: (version: string) => void): () => void;
}

interface RegistryState { readonly skipped: readonly string[]; readonly notified: readonly string[]; }

const DEFAULT_TIMEOUT_MILLISECONDS = 3_000;
const DEFAULT_POLL_INTERVAL_MILLISECONDS = 60 * 60 * 1_000;

export function createRegistryChecker(options: RegistryCheckerOptions): RegistryChecker {
  const dependencies = options.dependencies ?? createRegistryCheckDependencies();
  const timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
  const pollIntervalMilliseconds = options.pollIntervalMilliseconds ?? DEFAULT_POLL_INTERVAL_MILLISECONDS;
  const check = async (currentVersion: string): Promise<RegistryCheckResult> => {
    const fetched = await fetchLatest(options.packageName, timeoutMilliseconds, dependencies.fetch);
    // latest는 "설치 후보(현재보다 상위 버전)"일 때만 노출한다 — registry가 로컬 설치본보다
    // 뒤처진 경우(카나리 선행 등) 매 부팅 다운그레이드가 일어나는 것을 막는 가드.
    const latest = fetched && isNewerVersion(fetched, currentVersion) ? fetched : null;
    if (!latest) return { latest, shouldNotify: false };
    const state = await readState(options.statePath, dependencies.fileSystem);
    if (state.skipped.includes(latest) || state.notified.includes(latest)) return { latest, shouldNotify: false };
    await writeState(options.statePath, { ...state, notified: [...state.notified, latest] }, dependencies.fileSystem);
    return { latest, shouldNotify: true };
  };
  return {
    check,
    async skip(version) {
      const state = await readState(options.statePath, dependencies.fileSystem);
      await writeState(options.statePath, { skipped: unique([...state.skipped, version]), notified: state.notified }, dependencies.fileSystem);
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

async function fetchLatest(packageName: string, timeoutMilliseconds: number, fetcher: RegistryCheckDependencies["fetch"]): Promise<string | null> {
  try {
    const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, { signal: AbortSignal.timeout(timeoutMilliseconds) });
    if (!response.ok) return null;
    const payload = await response.json();
    const latest = typeof payload === "object" && payload !== null && "dist-tags" in payload ? (payload["dist-tags"] as Record<string, unknown>).latest : undefined;
    return typeof latest === "string" ? latest : null;
  } catch {
    return null;
  }
}

async function readState(statePath: string, fileSystem: RegistryCheckFileSystem): Promise<RegistryState> {
  try {
    const parsed = JSON.parse(await fileSystem.readFile(statePath)) as Partial<RegistryState>;
    return { skipped: Array.isArray(parsed.skipped) ? parsed.skipped.filter(isString) : [], notified: Array.isArray(parsed.notified) ? parsed.notified.filter(isString) : [] };
  } catch {
    return { skipped: [], notified: [] };
  }
}

async function writeState(statePath: string, state: RegistryState, fileSystem: RegistryCheckFileSystem): Promise<void> {
  await fileSystem.writeFile(statePath, JSON.stringify(state));
}

function unique(values: readonly string[]): string[] { return [...new Set(values)]; }

function isString(value: unknown): value is string { return typeof value === "string"; }

// dist-tags latest는 정식 릴리스(x.y.z) 관례를 따른다 — 비정형 버전은 보수적으로 설치 대상에서 제외한다.
function isNewerVersion(candidate: string, current: string): boolean {
  if (!current) return true;
  const a = parseVersionTriplet(candidate);
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
