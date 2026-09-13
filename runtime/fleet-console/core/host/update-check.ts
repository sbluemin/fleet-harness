import { fetchLatestVersion, isVersionGreater } from "@dotobokuri/core-agent";

import { readFleetConsoleRelease, type FleetConsoleRelease } from "./release.js";

export interface ConsoleUpdateStatus {
  readonly updateAvailable: boolean;
  readonly latestVersion?: string;
}

export interface ConsoleUpdateCheckService {
  getStatus(): ConsoleUpdateStatus;
  refresh(options?: ConsoleUpdateRefreshOptions): Promise<ConsoleUpdateStatus>;
  /** 지금 레지스트리를 다시 묻는다. refresh와 달리 조회 실패를 "업데이트 없음"으로 뭉개지 않고 거부한다. */
  check?(): Promise<ConsoleUpdateStatus>;
  start?(): void;
  stop?(): void;
  onChange?(listener: ConsoleUpdateCheckChangeListener): () => void;
}

export interface ConsoleUpdateCheckDeps {
  readonly readRelease?: () => FleetConsoleRelease;
  readonly fetchLatest?: (packageName: string, channel?: string) => Promise<string | undefined>;
  readonly isGreater?: (left: string, right: string) => boolean;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly errorTtlMs?: number;
  readonly intervalMs?: number;
  readonly setInterval?: (callback: () => void, delayMs: number) => ConsoleUpdateCheckInterval;
  readonly clearInterval?: (interval: ConsoleUpdateCheckInterval) => void;
}

export interface ConsoleUpdateRefreshOptions {
  readonly force?: boolean;
}

export type ConsoleUpdateCheckChangeListener = (status: ConsoleUpdateStatus) => void;

interface CachedConsoleUpdateStatus {
  readonly status: ConsoleUpdateStatus;
  readonly checkedAt: number;
  readonly ttlMs: number;
}

export interface ConsoleUpdateCheckInterval {
  unref?(): void;
}

const FLEET_CONSOLE_PACKAGE_NAME = "@dotobokuri/fleet-console";
const UPDATE_CHECK_TTL_MS = 60 * 60 * 1000;
const UPDATE_CHECK_ERROR_TTL_MS = 5 * 60 * 1000;
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const NO_UPDATE_STATUS: ConsoleUpdateStatus = { updateAvailable: false };

export function createConsoleUpdateCheckService(deps: ConsoleUpdateCheckDeps = {}): ConsoleUpdateCheckService {
  const readRelease = deps.readRelease ?? readFleetConsoleRelease;
  const fetchLatest = deps.fetchLatest ?? fetchLatestVersion;
  const isGreater = deps.isGreater ?? isVersionGreater;
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? UPDATE_CHECK_TTL_MS;
  const errorTtlMs = deps.errorTtlMs ?? UPDATE_CHECK_ERROR_TTL_MS;
  const intervalMs = deps.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;
  const startInterval = deps.setInterval ?? ((callback, delayMs) => setInterval(callback, delayMs));
  const stopInterval = deps.clearInterval ?? ((interval) => clearInterval(interval as NodeJS.Timeout));
  let cached: CachedConsoleUpdateStatus | null = null;
  let inFlight: Promise<ConsoleUpdateStatus> | null = null;
  let interval: ConsoleUpdateCheckInterval | null = null;
  const changeListeners = new Set<ConsoleUpdateCheckChangeListener>();

  const getStatus = (): ConsoleUpdateStatus => {
    const current = cached;
    if (current && now() - current.checkedAt < current.ttlMs) {
      return current.status;
    }
    void refresh();
    return current?.status ?? NO_UPDATE_STATUS;
  };

  // 조회 한 번을 공유한다. 실패는 짧은 오류 TTL로 캐시하되 약속 자체는 거부한 채 두어,
  // 배경 갱신(refresh)은 "없음"으로 내려앉고 사용자가 누른 확인(check)은 실패를 실패로 안다.
  const lookup = (): Promise<ConsoleUpdateStatus> => {
    if (inFlight) return inFlight;
    inFlight = resolveUpdateStatus()
      .then((status) => {
        const previousStatus = cached?.status ?? NO_UPDATE_STATUS;
        cached = { status, checkedAt: now(), ttlMs };
        notifyIfChanged(previousStatus, status);
        return status;
      })
      .catch((error: unknown) => {
        // 조회 실패는 "모름"이지 "없음"이 아니다. 마지막으로 확인된 상태를 짧은 오류 TTL로 붙들어,
        // 이미 알려진 업데이트가 일시적 장애로 사라졌다 돌아오지 않게 한다.
        cached = { status: cached?.status ?? NO_UPDATE_STATUS, checkedAt: now(), ttlMs: errorTtlMs };
        throw error;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const refresh = async (options: ConsoleUpdateRefreshOptions = {}): Promise<ConsoleUpdateStatus> => {
    const current = cached;
    if (options.force !== true && current && now() - current.checkedAt < current.ttlMs) {
      return current.status;
    }
    return lookup().catch(() => NO_UPDATE_STATUS);
  };

  const check = (): Promise<ConsoleUpdateStatus> => lookup();

  const resolveUpdateStatus = async (): Promise<ConsoleUpdateStatus> => {
    const release = readRelease();
    if (release.channel === "local") {
      return NO_UPDATE_STATUS;
    }
    const latestVersion = await fetchLatest(FLEET_CONSOLE_PACKAGE_NAME);
    if (latestVersion === undefined) {
      // 실 fetchLatestVersion은 타임아웃·비정상 응답에서 throw 대신 undefined를 반환하므로,
      // 여기서 throw로 승격해야 조회 실패가 짧은 오류 TTL(catch 경로)로 캐시된다.
      throw new Error("registry lookup failed");
    }
    if (!isGreater(latestVersion, release.version)) {
      return NO_UPDATE_STATUS;
    }
    return { updateAvailable: true, latestVersion };
  };

  const start = (): void => {
    if (interval) return;
    interval = startInterval(() => {
      void refresh({ force: true });
    }, intervalMs);
    interval.unref?.();
  };

  const stop = (): void => {
    if (!interval) return;
    stopInterval(interval);
    interval = null;
  };

  const onChange = (listener: ConsoleUpdateCheckChangeListener): (() => void) => {
    changeListeners.add(listener);
    return () => changeListeners.delete(listener);
  };

  function notifyIfChanged(previous: ConsoleUpdateStatus, next: ConsoleUpdateStatus): void {
    const updateBecameAvailable = !previous.updateAvailable && next.updateAvailable;
    const latestVersionChanged = previous.latestVersion !== next.latestVersion;
    if (!updateBecameAvailable && !latestVersionChanged) return;
    for (const listener of changeListeners) {
      try {
        listener(next);
      } catch {
        // An observer must not turn a completed registry lookup into an error cache entry.
      }
    }
  }

  return { getStatus, refresh, check, start, stop, onChange };
}
