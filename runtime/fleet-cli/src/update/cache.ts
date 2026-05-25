import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getFleetDataDir } from "@dotobokuri/fleet-infra/data-dir";

import type { UpdateChannel } from "./registry.js";

interface UpdateCheckCache {
  readonly channel: UpdateChannel;
  readonly checkedAt: number;
  readonly latest: string;
}

const UPDATE_CACHE_TTL_MS = 60 * 60 * 1000;
const UPDATE_CACHE_FILENAME = "update-check.json";

export function readCachedLatestVersion(channel: UpdateChannel): string | undefined {
  try {
    if (!existsSync(getUpdateCachePath())) {
      return undefined;
    }
    const parsed = JSON.parse(readFileSync(getUpdateCachePath(), "utf8")) as Partial<UpdateCheckCache>;
    if (parsed.channel !== channel || typeof parsed.latest !== "string" || typeof parsed.checkedAt !== "number") {
      return undefined;
    }
    if (Date.now() - parsed.checkedAt >= UPDATE_CACHE_TTL_MS) {
      return undefined;
    }
    return parsed.latest;
  } catch {
    return undefined;
  }
}

export function writeCachedLatestVersion(channel: UpdateChannel, latest: string): void {
  try {
    mkdirSync(getFleetDataDir(), { recursive: true });
    writeFileSync(getUpdateCachePath(), JSON.stringify({ channel, latest, checkedAt: Date.now() }), "utf8");
  } catch {}
}

function getUpdateCachePath(): string {
  return path.join(getFleetDataDir(), UPDATE_CACHE_FILENAME);
}
