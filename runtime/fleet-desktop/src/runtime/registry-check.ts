export interface RegistryResponse {
  readonly ok: boolean;
  json(): Promise<unknown>;
}

export interface RegistryCheckDependencies {
  readonly fetch: (url: string, init: { signal: AbortSignal }) => Promise<RegistryResponse>;
}

export interface RegistryCheckerOptions {
  readonly packageName: string;
  readonly timeoutMilliseconds?: number;
  readonly dependencies?: RegistryCheckDependencies;
}

export interface RegistryCheckResult {
  readonly latest: string | null;
  readonly unavailable?: boolean;
}

/**
 * 관리형 Console을 조달할 때 "무엇을 설치할 것인가"를 정하는 한 가지 물음. 셸 자신의 갱신과는
 * 다른 축이다(shell-update.ts) — 그쪽은 GitHub 릴리스를, 이쪽은 npm 레지스트리를 본다.
 */
export interface RegistryChecker {
  check(currentVersion: string): Promise<RegistryCheckResult>;
}

const DEFAULT_TIMEOUT_MILLISECONDS = 3_000;

export function createRegistryChecker(options: RegistryCheckerOptions): RegistryChecker {
  const dependencies = options.dependencies ?? createRegistryCheckDependencies();
  const timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
  const check = async (currentVersion: string): Promise<RegistryCheckResult> => {
    const fetched = await fetchLatest(options.packageName, timeoutMilliseconds, dependencies.fetch);
    // latest는 "설치 후보(현재보다 상위 버전)"일 때만 노출한다 — registry가 로컬 설치본보다
    // 뒤처진 경우(카나리 선행 등) 매 부팅 다운그레이드가 일어나는 것을 막는 가드.
    if (fetched.unavailable) return { latest: null, unavailable: true };
    return { latest: fetched.latest && isNewerVersion(fetched.latest, currentVersion) ? fetched.latest : null };
  };
  return { check };
}

function createRegistryCheckDependencies(): RegistryCheckDependencies {
  return { fetch: async (url, init) => fetch(url, init) };
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
