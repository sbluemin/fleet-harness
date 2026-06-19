import { fetchLatestVersion, isVersionGreater } from "@dotobokuri/core-agent";

import { readFleetConsoleRelease, type FleetConsoleRelease } from "./release.js";

export interface ConsoleUpdateStatus {
  readonly updateAvailable: boolean;
  readonly latestVersion?: string;
}

export interface ConsoleUpdateCheckService {
  getStatus(): ConsoleUpdateStatus;
  refresh(options?: ConsoleUpdateRefreshOptions): Promise<ConsoleUpdateStatus>;
}

export interface ConsoleUpdateCheckDeps {
  readonly readRelease?: () => FleetConsoleRelease;
  readonly fetchLatest?: (packageName: string, channel?: string) => Promise<string | undefined>;
  readonly isGreater?: (left: string, right: string) => boolean;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

export interface ConsoleUpdateRefreshOptions {
  readonly force?: boolean;
}

interface CachedConsoleUpdateStatus {
  readonly status: ConsoleUpdateStatus;
  readonly checkedAt: number;
}

const FLEET_CONSOLE_PACKAGE_NAME = "@dotobokuri/fleet-console";
const UPDATE_CHECK_TTL_MS = 60 * 60 * 1000;
const NO_UPDATE_STATUS: ConsoleUpdateStatus = { updateAvailable: false };

export function createConsoleUpdateCheckService(deps: ConsoleUpdateCheckDeps = {}): ConsoleUpdateCheckService {
  const readRelease = deps.readRelease ?? readFleetConsoleRelease;
  const fetchLatest = deps.fetchLatest ?? fetchLatestVersion;
  const isGreater = deps.isGreater ?? isVersionGreater;
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? UPDATE_CHECK_TTL_MS;
  let cached: CachedConsoleUpdateStatus | null = null;
  let inFlight: Promise<ConsoleUpdateStatus> | null = null;

  const getStatus = (): ConsoleUpdateStatus => {
    const current = cached;
    if (current && now() - current.checkedAt < ttlMs) {
      return current.status;
    }
    void refresh();
    return current?.status ?? NO_UPDATE_STATUS;
  };

  const refresh = async (options: ConsoleUpdateRefreshOptions = {}): Promise<ConsoleUpdateStatus> => {
    const current = cached;
    if (options.force !== true && current && now() - current.checkedAt < ttlMs) {
      return current.status;
    }
    if (inFlight) {
      return inFlight;
    }
    inFlight = resolveUpdateStatus()
      .then((status) => {
        cached = { status, checkedAt: now() };
        return status;
      })
      .catch(() => {
        cached = { status: NO_UPDATE_STATUS, checkedAt: now() };
        return NO_UPDATE_STATUS;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const resolveUpdateStatus = async (): Promise<ConsoleUpdateStatus> => {
    const release = readRelease();
    if (release.channel === "local") {
      return NO_UPDATE_STATUS;
    }
    const latestVersion = await fetchLatest(FLEET_CONSOLE_PACKAGE_NAME);
    if (!latestVersion || !isGreater(latestVersion, release.version)) {
      return NO_UPDATE_STATUS;
    }
    return { updateAvailable: true, latestVersion };
  };

  return { getStatus, refresh };
}
