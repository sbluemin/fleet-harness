import {
  CONSOLE_RELEASE_EXPERIMENT_TAG_PREFIX,
  CONSOLE_RELEASE_TAG_OVERRIDE_ENV,
  readConsoleReleaseTagOverride,
  type ConsoleReleaseManifest,
} from "@fleet-console/protocol/release";
import { isVersionGreater, type ConsoleReleaseLookupFailure } from "@fleet-console/updates";

import type { FleetCliRelease } from "../release.js";
import { readCachedLatestVersion, writeCachedLatestVersion } from "./cache.js";
import { fetchFleetCliRelease } from "./registry.js";

export type UpdateCheckResult =
  | { readonly status: "current"; readonly latest: string }
  /** `reason` is absent only when no lookup was attempted (a local build or an unknown version). */
  | { readonly status: "unavailable"; readonly reason?: ConsoleReleaseLookupFailure }
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
    return { status: "unavailable", reason: "invalid_override" };
  }
  if (options.forceRefresh !== true) {
    const cached = readCachedLatestVersion(source);
    if (cached !== undefined) {
      return isVersionGreater(cached, release.version) ? { status: "update", latest: cached } : { status: "current", latest: cached };
    }
  }
  const lookup = await fetchFleetCliRelease(env);
  if (!lookup.ok) {
    return { status: "unavailable", reason: lookup.reason };
  }
  const latest = lookup.manifest.version;
  writeCachedLatestVersion(source, latest);
  return isVersionGreater(latest, release.version) ? { status: "update", latest, release: lookup.manifest } : { status: "current", latest };
}

/** One line saying why the release could not be read, so a bad tag is not mistaken for a network failure. */
export function describeReleaseLookupFailure(reason: ConsoleReleaseLookupFailure | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const tag = readConsoleReleaseTagOverride(env);
  switch (reason) {
    case "invalid_override":
      return `${CONSOLE_RELEASE_TAG_OVERRIDE_ENV} is not a Fleet release tag (expected v<version> or ${CONSOLE_RELEASE_EXPERIMENT_TAG_PREFIX}<version>).`;
    case "not_found":
      return tag.kind === "tag"
        ? `GitHub has no Fleet release information for ${tag.tag}.`
        : "GitHub has no Fleet release information for the latest release.";
    case "invalid_manifest":
      return "The Fleet release information on GitHub is not valid.";
    default:
      return "Could not reach GitHub to read the Fleet release information.";
  }
}

/** Cache entries are keyed by what was asked, so an experiment tag never answers for latest stable. */
function resolveUpdateSource(env: NodeJS.ProcessEnv): string | undefined {
  const override = readConsoleReleaseTagOverride(env);
  if (override.kind === "invalid") return undefined;
  return override.kind === "tag" ? override.tag : "latest";
}
