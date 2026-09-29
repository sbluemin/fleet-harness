import { readConsoleReleaseTagOverride, type ConsoleReleaseManifest } from "@fleet-console/protocol/release";
import { isVersionGreater } from "@fleet-console/updates";

import type { FleetCliRelease } from "../release.js";
import { readCachedLatestVersion, writeCachedLatestVersion } from "./cache.js";
import { fetchFleetCliRelease } from "./registry.js";

export type UpdateCheckResult =
  | { readonly status: "current"; readonly latest: string }
  | { readonly status: "unavailable" }
  /** `release` is present only when this check read the manifest itself rather than the cache. */
  | { readonly status: "update"; readonly latest: string; readonly release?: ConsoleReleaseManifest };

export interface UpdateCheckOptions {
  readonly forceRefresh?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

export async function checkForUpdate(release: FleetCliRelease | undefined): Promise<string | undefined> {
  const result = await checkUpdateStatus(release);
  return result.status === "update" ? result.latest : undefined;
}

export async function checkUpdateStatus(release: FleetCliRelease | undefined, options: UpdateCheckOptions = {}): Promise<UpdateCheckResult> {
  if (release === undefined || release.version.length === 0 || release.channel === "local") {
    return { status: "unavailable" };
  }
  const env = options.env ?? process.env;
  const source = resolveUpdateSource(env);
  if (source === undefined) {
    return { status: "unavailable" };
  }
  if (options.forceRefresh !== true) {
    const cached = readCachedLatestVersion(source);
    if (cached !== undefined) {
      return isVersionGreater(cached, release.version) ? { status: "update", latest: cached } : { status: "current", latest: cached };
    }
  }
  const lookup = await fetchFleetCliRelease(env);
  if (!lookup.ok) {
    return { status: "unavailable" };
  }
  const latest = lookup.manifest.version;
  writeCachedLatestVersion(source, latest);
  return isVersionGreater(latest, release.version) ? { status: "update", latest, release: lookup.manifest } : { status: "current", latest };
}

/** Cache entries are keyed by what was asked, so an experiment tag never answers for latest stable. */
function resolveUpdateSource(env: NodeJS.ProcessEnv): string | undefined {
  const override = readConsoleReleaseTagOverride(env);
  if (override.kind === "invalid") return undefined;
  return override.kind === "tag" ? override.tag : "latest";
}
