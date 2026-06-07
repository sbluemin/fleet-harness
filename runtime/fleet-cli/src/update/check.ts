import type { FleetCliRelease } from "../release.js";
import { readCachedLatestVersion, writeCachedLatestVersion } from "./cache.js";
import { fetchLatestFleetCliVersion, type UpdateChannel } from "./registry.js";
import { isVersionGreater } from "./semver.js";

export type UpdateCheckResult =
  | { readonly status: "current"; readonly latest: string }
  | { readonly status: "unavailable" }
  | { readonly status: "update"; readonly latest: string };

export interface UpdateCheckOptions {
  readonly forceRefresh?: boolean;
}

export function resolveUpdateChannel(_version: string): UpdateChannel {
  // canary 채널 운영을 종료하면서 모든 게시 빌드는 latest dist-tag만 사용한다.
  return "latest";
}

export async function checkForUpdate(release: FleetCliRelease | undefined): Promise<string | undefined> {
  const result = await checkUpdateStatus(release);
  return result.status === "update" ? result.latest : undefined;
}

export async function checkUpdateStatus(release: FleetCliRelease | undefined, options: UpdateCheckOptions = {}): Promise<UpdateCheckResult> {
  if (release === undefined || release.version.length === 0 || release.channel === "local") {
    return { status: "unavailable" };
  }
  const channel = resolveUpdateChannel(release.version);
  if (options.forceRefresh !== true) {
    const cached = readCachedLatestVersion(channel);
    if (cached !== undefined) {
      return isVersionGreater(cached, release.version) ? { status: "update", latest: cached } : { status: "current", latest: cached };
    }
  }
  const latest = await fetchLatestFleetCliVersion(channel);
  if (latest === undefined) {
    return { status: "unavailable" };
  }
  writeCachedLatestVersion(channel, latest);
  return isVersionGreater(latest, release.version) ? { status: "update", latest } : { status: "current", latest };
}
