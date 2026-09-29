import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  MAX_CONSOLE_RELEASE_MANIFEST_BYTES,
  MAX_CONSOLE_RELEASE_REDIRECTS,
  consoleReleaseManifestUrl,
  consoleReleaseTarballUrl,
  isAllowedConsoleReleaseDownloadUrl,
  parseConsoleReleaseManifest,
  readConsoleReleaseTagOverride,
  type ConsoleReleaseManifest,
} from "@fleet-console/protocol/release";

export type ConsoleReleaseFetch = (url: string, init: { readonly redirect: "manual"; readonly signal: AbortSignal }) => Promise<Response>;

/**
 * Why a release could not be read. `not_found` is a published release without a manifest (or no
 * release at all); `invalid_override` is a malformed `FLEET_CONSOLE_RELEASE_TAG`, reported rather
 * than silently falling back to the latest stable release.
 */
export type ConsoleReleaseLookupFailure = "invalid_override" | "not_found" | "unreachable" | "invalid_manifest";

export type ConsoleReleaseLookup =
  | { readonly ok: true; readonly manifest: ConsoleReleaseManifest }
  | { readonly ok: false; readonly reason: ConsoleReleaseLookupFailure };

export type ConsoleTarballDownloadFailure = "download_failed" | "checksum_mismatch";

export type ConsoleTarballDownload =
  | { readonly ok: true; readonly tarballPath: string }
  | { readonly ok: false; readonly reason: ConsoleTarballDownloadFailure };

export interface FetchConsoleReleaseOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: ConsoleReleaseFetch;
  readonly timeoutMs?: number;
}

export interface DownloadConsoleTarballOptions {
  /**
   * Where verified tarballs live. The installed one must outlive the install: pnpm records a global
   * tarball install as a `file:` dependency and fails every later global operation once it is gone.
   */
  readonly releasesDir: string;
  readonly fetch?: ConsoleReleaseFetch;
  readonly timeoutMs?: number;
}

const MANIFEST_TIMEOUT_MS = 10_000;
const TARBALL_TIMEOUT_MS = 5 * 60_000;
const STAGING_DIR_PREFIX = ".staging-";
const TARBALL_FILE_PATTERN = /^fleet-console-.+\.tgz$/;

class ReleaseRequestError extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? "release request failed" : `release request failed with status ${status}`);
  }
}

/** Reads the release this Console should follow: the latest stable one, or the tag the environment names. */
export async function fetchConsoleRelease(options: FetchConsoleReleaseOptions = {}): Promise<ConsoleReleaseLookup> {
  const override = readConsoleReleaseTagOverride(options.env ?? process.env);
  if (override.kind === "invalid") return { ok: false, reason: "invalid_override" };
  const tag = override.kind === "tag" ? override.tag : undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? MANIFEST_TIMEOUT_MS);
  timer.unref?.();
  let text: string | null;
  try {
    const response = await fetchReleaseAsset(consoleReleaseManifestUrl(tag), options.fetch ?? defaultFetch, controller.signal);
    text = await readTextWithByteLimit(response, MAX_CONSOLE_RELEASE_MANIFEST_BYTES, controller);
  } catch (error) {
    return { ok: false, reason: error instanceof ReleaseRequestError && error.status === 404 ? "not_found" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
  if (text === null) return { ok: false, reason: "invalid_manifest" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid_manifest" };
  }
  const parsed = parseConsoleReleaseManifest(json, tag === undefined ? {} : { tag });
  return parsed.ok ? { ok: true, manifest: parsed.manifest } : { ok: false, reason: "invalid_manifest" };
}

/**
 * Downloads the manifest's tarball into a private staging directory and keeps it only when its size
 * and sha256 match. Nothing about the running Console changes here, so every failure leaves it
 * serving as before.
 */
export async function downloadVerifiedConsoleTarball(manifest: ConsoleReleaseManifest, options: DownloadConsoleTarballOptions): Promise<ConsoleTarballDownload> {
  fs.mkdirSync(options.releasesDir, { recursive: true, mode: 0o700 });
  const stagingDir = fs.mkdtempSync(path.join(options.releasesDir, STAGING_DIR_PREFIX));
  fs.chmodSync(stagingDir, 0o700);
  const partialPath = path.join(stagingDir, `${manifest.tarball.name}.partial`);
  const tarballPath = path.join(options.releasesDir, manifest.tarball.name);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TARBALL_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetchReleaseAsset(consoleReleaseTarballUrl(manifest), options.fetch ?? defaultFetch, controller.signal);
    const written = await writeVerifiedBody(response, manifest, partialPath, controller);
    if (!written.ok) return written;
    fs.renameSync(partialPath, tarballPath);
    return { ok: true, tarballPath };
  } catch {
    return { ok: false, reason: "download_failed" };
  } finally {
    clearTimeout(timer);
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

/** After a successful install, only the installed tarball stays; earlier ones and stale staging go. */
export function retainOnlyConsoleReleaseTarball(releasesDir: string, installedTarballPath: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(releasesDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(releasesDir, entry);
    if (entryPath === installedTarballPath) continue;
    if (!TARBALL_FILE_PATTERN.test(entry) && !entry.startsWith(STAGING_DIR_PREFIX)) continue;
    try {
      fs.rmSync(entryPath, { recursive: true, force: true });
    } catch {
      // Pruning is housekeeping; a leftover file never blocks the next update.
    }
  }
}

/**
 * Follows redirects by hand so every hop is checked against the release host allowlist before a
 * request is sent there. The sha256 in the manifest is still the trust anchor for the bytes.
 */
async function fetchReleaseAsset(url: string, fetchImpl: ConsoleReleaseFetch, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_CONSOLE_RELEASE_REDIRECTS; hop += 1) {
    if (!isAllowedConsoleReleaseDownloadUrl(current)) throw new ReleaseRequestError(null);
    const response = await fetchImpl(current, { redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (location === null) throw new ReleaseRequestError(response.status);
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ReleaseRequestError(response.status);
    }
    return response;
  }
  throw new ReleaseRequestError(null);
}

async function readTextWithByteLimit(response: Response, limit: number, controller: AbortController): Promise<string | null> {
  const body = response.body;
  if (body === null) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        controller.abort();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function writeVerifiedBody(response: Response, manifest: ConsoleReleaseManifest, partialPath: string, controller: AbortController): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: ConsoleTarballDownloadFailure }> {
  const body = response.body;
  if (body === null) return { ok: false, reason: "download_failed" };
  const expectedSize = manifest.tarball.size;
  const hash = createHash("sha256");
  const handle = fs.openSync(partialPath, "wx", 0o600);
  const reader = body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      // Anything longer than the manifest promised is not the release, whatever its hash would say.
      if (total > expectedSize) {
        controller.abort();
        return { ok: false, reason: "checksum_mismatch" };
      }
      hash.update(value);
      fs.writeSync(handle, value);
    }
  } finally {
    reader.releaseLock();
    fs.closeSync(handle);
  }
  if (total !== expectedSize || hash.digest("hex") !== manifest.tarball.sha256) return { ok: false, reason: "checksum_mismatch" };
  return { ok: true };
}

function defaultFetch(url: string, init: { readonly redirect: "manual"; readonly signal: AbortSignal }): Promise<Response> {
  return fetch(url, { redirect: init.redirect, signal: init.signal, headers: { accept: "application/octet-stream" } });
}

/** The one place verified release tarballs are kept, under the Fleet data root the caller resolved. */
export function consoleReleaseTarballDir(fleetDataDir: string): string {
  return path.join(fleetDataDir, "console-releases");
}
