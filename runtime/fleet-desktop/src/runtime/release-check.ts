import { createHash } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import {
  MAX_CONSOLE_RELEASE_MANIFEST_BYTES,
  MAX_CONSOLE_RELEASE_REDIRECTS,
  consoleReleaseManifestUrl,
  consoleReleaseTarballUrl,
  isAllowedConsoleReleaseDownloadUrl,
  isExperimentConsoleVersion,
  isStableConsoleVersion,
  parseConsoleReleaseManifest,
  readConsoleReleaseTagOverride,
  type ConsoleReleaseManifest,
} from "@fleet-console/protocol/release";

export type ReleaseFetch = (url: string, init: { readonly redirect: "manual"; readonly signal: AbortSignal }) => Promise<Response>;

export interface ReleaseCheckDependencies {
  readonly fetch: ReleaseFetch;
}

export interface ReleaseCheckerOptions {
  /** Where `FLEET_CONSOLE_RELEASE_TAG` is read. A malformed value is reported as unavailable, never ignored. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMilliseconds?: number;
  readonly dependencies?: ReleaseCheckDependencies;
}

export interface ReleaseCheckResult {
  /** Present only when the release is newer than the installed build. */
  readonly release: ConsoleReleaseManifest | null;
  readonly unavailable?: boolean;
}

/**
 * 관리형 Console을 조달할 때 "무엇을 설치할 것인가"를 정하는 한 가지 물음. 셸 자신의 갱신과는
 * 다른 축이다(shell-update.ts) — 둘 다 GitHub Release를 보지만, 이쪽은 Console 릴리스의 고정
 * manifest만 읽는다.
 */
export interface ReleaseChecker {
  check(currentVersion: string): Promise<ReleaseCheckResult>;
}

export interface DownloadConsoleTarballOptions {
  readonly directory: string;
  readonly timeoutMilliseconds?: number;
  readonly dependencies?: ReleaseCheckDependencies;
}

const DEFAULT_TIMEOUT_MILLISECONDS = 3_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MILLISECONDS = 5 * 60_000;
const VERSION_PARTS = /^(\d+)\.(\d+)\.(\d+)(?:-exp\.(\d+))?$/;

class ReleaseRequestError extends Error {}

export function createReleaseChecker(options: ReleaseCheckerOptions = {}): ReleaseChecker {
  const dependencies = options.dependencies ?? createReleaseCheckDependencies();
  const timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
  const check = async (currentVersion: string): Promise<ReleaseCheckResult> => {
    const override = readConsoleReleaseTagOverride(options.environment ?? process.env);
    if (override.kind === "invalid") return { release: null, unavailable: true };
    const tag = override.kind === "tag" ? override.tag : undefined;
    const manifest = await fetchManifest(tag, timeoutMilliseconds, dependencies.fetch);
    if (manifest === null) return { release: null, unavailable: true };
    // 설치 후보는 "설치본보다 새 릴리스"일 때만 노출한다 — 릴리스가 로컬 설치본보다 뒤처진
    // 경우(실험 빌드 선행 등) 매 부팅 다운그레이드가 일어나는 것을 막는 가드.
    return { release: isNewerConsoleVersion(manifest.version, currentVersion) ? manifest : null };
  };
  return { check };
}

/**
 * Downloads the manifest's tarball and keeps it only when its size and sha256 match — the same
 * hash-before-use rule as the managed Node archive. The caller owns removal of `directory`.
 */
export async function downloadVerifiedConsoleTarball(manifest: ConsoleReleaseManifest, options: DownloadConsoleTarballOptions): Promise<string> {
  const dependencies = options.dependencies ?? createReleaseCheckDependencies();
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const tarballPath = path.join(options.directory, manifest.tarball.name);
  const partialPath = `${tarballPath}.partial`;
  const signal = AbortSignal.timeout(options.timeoutMilliseconds ?? DEFAULT_DOWNLOAD_TIMEOUT_MILLISECONDS);
  let response: Response;
  try {
    response = await fetchReleaseAsset(consoleReleaseTarballUrl(manifest), dependencies.fetch, signal);
  } catch (error) {
    throw new Error("console_release_download_failed", { cause: error });
  }
  const body = response.body;
  if (body === null) throw new Error("console_release_download_failed");
  const hash = createHash("sha256");
  const handle = openSync(partialPath, "wx", 0o600);
  const reader = body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > manifest.tarball.size) break;
      hash.update(value);
      writeSync(handle, value);
    }
  } catch (error) {
    await rm(partialPath, { force: true });
    throw new Error("console_release_download_failed", { cause: error });
  } finally {
    await reader.cancel().catch(() => {});
    closeSync(handle);
  }
  if (total !== manifest.tarball.size || hash.digest("hex") !== manifest.tarball.sha256) {
    await rm(partialPath, { force: true });
    throw new Error("console_release_checksum_mismatch");
  }
  await rename(partialPath, tarballPath);
  return tarballPath;
}

/** Release versions only: `X.Y.Z` or `X.Y.Z-exp.N`, where a stable build outranks its own experiments. */
export function isNewerConsoleVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  if (!next) return false;
  if (!current) return true;
  const installed = parseVersion(current);
  if (!installed) return false;
  for (let index = 0; index < next.length; index += 1) {
    const a = next[index] ?? 0;
    const b = installed[index] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

function parseVersion(version: string): readonly number[] | null {
  if (!isStableConsoleVersion(version) && !isExperimentConsoleVersion(version)) return null;
  const match = VERSION_PARTS.exec(version);
  if (!match) return null;
  // 정식 릴리스는 같은 X.Y.Z의 어떤 실험 빌드보다 뒤에 온다.
  const experiment = match[4] === undefined ? Number.MAX_SAFE_INTEGER : Number(match[4]);
  return [Number(match[1]), Number(match[2]), Number(match[3]), experiment];
}

async function fetchManifest(tag: string | undefined, timeoutMilliseconds: number, fetcher: ReleaseFetch): Promise<ConsoleReleaseManifest | null> {
  try {
    const response = await fetchReleaseAsset(consoleReleaseManifestUrl(tag), fetcher, AbortSignal.timeout(timeoutMilliseconds));
    const text = await readTextWithLimit(response, MAX_CONSOLE_RELEASE_MANIFEST_BYTES);
    if (text === null) return null;
    const parsed = parseConsoleReleaseManifest(JSON.parse(text), tag === undefined ? {} : { tag });
    return parsed.ok ? parsed.manifest : null;
  } catch {
    return null;
  }
}

/** Every redirect hop is checked against the release host allowlist before a request goes there. */
async function fetchReleaseAsset(url: string, fetcher: ReleaseFetch, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_CONSOLE_RELEASE_REDIRECTS; hop += 1) {
    if (!isAllowedConsoleReleaseDownloadUrl(current)) throw new ReleaseRequestError("console_release_host_refused");
    const response = await fetcher(current, { redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (location === null) throw new ReleaseRequestError("console_release_redirect_invalid");
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ReleaseRequestError(`console_release_request_failed: ${response.status}`);
    }
    return response;
  }
  throw new ReleaseRequestError("console_release_redirect_limit");
}

async function readTextWithLimit(response: Response, limit: number): Promise<string | null> {
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
      if (total > limit) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function createReleaseCheckDependencies(): ReleaseCheckDependencies {
  return { fetch: (url, init) => fetch(url, { redirect: init.redirect, signal: init.signal }) };
}
