import type { FleetCliRelease } from "../release.js";
import { readCachedLatestVersion, writeCachedLatestVersion } from "./cache.js";
import { fetchLatestFleetCliVersion, type UpdateChannel } from "./registry.js";
import { isVersionGreater } from "./semver.js";

export function resolveUpdateChannel(version: string): UpdateChannel {
  return version.includes("-") ? "canary" : "latest";
}

export async function checkForUpdate(release: FleetCliRelease | undefined): Promise<string | undefined> {
  if (release === undefined || release.version.length === 0 || release.channel === "local") {
    return undefined;
  }
  const channel = resolveUpdateChannel(release.version);
  const cached = readCachedLatestVersion(channel);
  if (cached !== undefined) {
    return isVersionGreater(cached, release.version) ? cached : undefined;
  }
  const latest = await fetchLatestFleetCliVersion(channel);
  if (latest === undefined) {
    return undefined;
  }
  writeCachedLatestVersion(channel, latest);
  return isVersionGreater(latest, release.version) ? latest : undefined;
}
