import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { stat as nodeStat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

import {
  defaultCredentialDeps,
  optionalTrimmedString,
} from "../../transport/credentials.js";
import type { ProviderResult, QuotaScope, QuotaWindow, WindowId } from "../../quota/types.js";
import {
  HOUR_MS,
  WEEK_MS,
  object,
  safeTimestamp,
  windowPeriod,
  type ProviderDeps,
} from "../../quota/windows.js";

/** Print-mode `/usage` was added in agy 1.1.11. Older builds are not asked. */
const MIN_AGY_VERSION: readonly [number, number, number] = [1, 1, 11];

const VERSION_ARGS: readonly string[] = ["--version"];
const USAGE_ARGS: readonly string[] = ["-p", "/usage", "--output-format", "json"];

/** agy waits forever on an open stdin pipe (measured 2026-08-22). */
const AGY_STDIO = ["ignore", "pipe", "pipe"] as const;
const AGY_TIMEOUT_MS = 15_000;
const MAX_STDOUT_BYTES = 262_144;

/**
 * Not-logged-in agy 1.5.9 (measured 2026-11-16, isolated HOME).
 * stderr starts with this phrase, then the process waits up to 60s and exits 1
 * with `error` equal to {@link AGY_AUTH_FAILED_ERROR}. Both checks live here.
 */
const AGY_AUTH_REQUIRED_STDERR = "Authentication required";
const AGY_AUTH_FAILED_ERROR = "authentication failed or timed out";

/** 5-hour rolling window, the shorter of the two cadences Antigravity meters. */
const SESSION_MS = 5 * HOUR_MS;

/**
 * The buckets Antigravity reports, and what each one actually meters.
 *
 * Binding is on `id` alone. The sibling `name` ("Five Hour Limit Remaining")
 * and `window` ("5h") are presentation, and a build that relabels them must
 * not silently move a reading onto the wrong pool.
 *
 * Gemini and third-party pools never share headroom; Argon has its own weekly
 * pool too. Carbon does not: measured 2026-11-11, the quota summary had no
 * Carbon bucket and Carbon's per-model quotaInfo matched the Gemini pools, so
 * it is not a row here. Hydrogen measured the same way on 2026-11-13 and is
 * not a row either. This table is also the reason `reported: false` exists.
 * Fleet exposes Gemini models only, and a pool none of them can spend is not
 * this provider's headroom. Exposing a Claude or GPT model here is what flips
 * that flag, and the entries stay listed so that stays a one-word change.
 */
const BUCKETS: Readonly<Record<string, {
  readonly id: WindowId;
  readonly label: string;
  readonly durationMs: number;
  readonly reported: boolean;
  readonly scope?: QuotaScope;
}>> = Object.freeze({
  "gemini-5h": { id: "session", label: "Gemini", durationMs: SESSION_MS, reported: true },
  "gemini-weekly": { id: "weekly", label: "Gemini", durationMs: WEEK_MS, reported: true },
  "gemini-argon-wtu-weekly": {
    id: "weekly",
    label: "Gemini 4 Argon",
    durationMs: WEEK_MS,
    reported: true,
    scope: "model:gemini-4-argon",
  },
  "3p-5h": { id: "session", label: "Claude & GPT", durationMs: SESSION_MS, reported: false },
  "3p-weekly": { id: "weekly", label: "Claude & GPT", durationMs: WEEK_MS, reported: false },
});

/** Order the panel reads: within each spent pool, shorter cadences first. */
const BUCKET_ORDER: readonly string[] = Object.freeze(
  Object.keys(BUCKETS).filter((bucketId) => BUCKETS[bucketId]?.reported === true),
);

interface VersionCacheEntry {
  readonly key: string;
  readonly version: readonly [number, number, number] | null;
}

/** One entry: the binary path and mtime identify the build that was read. */
let versionCache: VersionCacheEntry | undefined;

export interface AntigravityCliSpawn {
  (
    file: string,
    args: readonly string[],
    options: SpawnOptions,
  ): {
    readonly stdout: Readable | null;
    readonly stderr: Readable | null;
    kill(signal?: NodeJS.Signals): boolean;
    on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
    on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  };
}

interface AntigravityQuotaDeps extends ProviderDeps {
  readonly stat?: (filePath: string) => Promise<{ readonly mtimeMs?: number }>;
  readonly spawn?: AntigravityCliSpawn;
}

interface AgyRun {
  readonly stdout: string;
  readonly stderrMatchedAuth: boolean;
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

/**
 * How every agy child is started, on every platform: hidden window, no stdin,
 * and auto-update left off. `--version` and `/usage` both use this.
 */
function agySpawnOptions(env: NodeJS.ProcessEnv): SpawnOptions {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") childEnv[key] = value;
  }
  childEnv.AGY_CLI_DISABLE_AUTO_UPDATE = "1";
  return {
    stdio: [...AGY_STDIO],
    windowsHide: true,
    env: childEnv,
  };
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function runAgy(
  spawnImpl: AntigravityCliSpawn,
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<AgyRun> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<AntigravityCliSpawn>;
    try {
      child = spawnImpl(file, [...args], agySpawnOptions(env));
    } catch (error) {
      reject(error);
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    let stderrMatchedAuth = false;
    let settled = false;
    const finish = (result: AgyRun | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const stop = (result: AgyRun): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child is already gone.
      }
      finish(result);
    };
    const timer = setTimeout(() => {
      stop({ stdout: "", stderrMatchedAuth, code: null, timedOut: true, truncated });
    }, AGY_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated || settled) return;
      total += chunk.length;
      if (total > MAX_STDOUT_BYTES) {
        truncated = true;
        chunks.length = 0;
        stop({ stdout: "", stderrMatchedAuth, code: null, timedOut: false, truncated: true });
        return;
      }
      chunks.push(chunk);
    });
    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (settled || stderrMatchedAuth) return;
      stderrTail += chunk.toString("utf8");
      if (stderrTail.includes(AGY_AUTH_REQUIRED_STDERR)) {
        stderrMatchedAuth = true;
        stderrTail = "";
        stop({ stdout: "", stderrMatchedAuth: true, code: null, timedOut: false, truncated: false });
        return;
      }
      if (stderrTail.length > 64) stderrTail = stderrTail.slice(-64);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      finish({
        stdout: truncated ? "" : Buffer.concat(chunks).toString("utf8"),
        stderrMatchedAuth,
        code,
        timedOut: false,
        truncated,
      });
    });
  });
}

function parseAgyVersion(stdout: string): readonly [number, number, number] | null {
  const line = stdout.split(/\r?\n/).map((item) => item.trim()).find((item) => item.length > 0);
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(line ?? "");
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(
  version: readonly [number, number, number],
  floor: readonly [number, number, number],
): boolean {
  for (let index = 0; index < 3; index += 1) {
    const left = version[index] ?? 0;
    const right = floor[index] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

function isExplicitPath(command: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    return path.win32.isAbsolute(command) || command.includes("\\") || command.includes("/");
  }
  return command.includes("/");
}

function pathCandidates(command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): readonly string[] {
  if (isExplicitPath(command, platform)) return [command];
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const pathEnv = platform === "win32" ? (env.Path ?? env.PATH ?? "") : (env.PATH ?? "");
  const names = platform === "win32" && path.win32.extname(command) === ""
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => `${command}${ext}`)
    : [command];
  const found: string[] = [];
  for (const dir of pathEnv.split(pathApi.delimiter)) {
    if (!dir) continue;
    for (const name of names) found.push(pathApi.join(dir, name));
  }
  return found;
}

async function locateAgy(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  statPath: NonNullable<AntigravityQuotaDeps["stat"]>,
): Promise<{ readonly path: string; readonly mtimeMs: number } | null> {
  for (const candidate of pathCandidates(command, platform, env)) {
    try {
      const info = await statPath(candidate);
      const mtimeMs = typeof info.mtimeMs === "number" && Number.isFinite(info.mtimeMs) ? info.mtimeMs : 0;
      return { path: candidate, mtimeMs };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      return { path: candidate, mtimeMs: 0 };
    }
  }
  return null;
}

function usedPercentFromRemaining(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const clamped = Math.min(1, Math.max(0, value));
  return Math.round((1 - clamped) * 100);
}

function mapReportedBuckets(root: Record<string, unknown>): readonly QuotaWindow[] | null {
  const command = object(root.command);
  if (command?.name !== "usage") return null;
  const groups = object(command.data)?.groups;
  if (!Array.isArray(groups)) return null;
  let sawBuckets = false;
  const byBucket = new Map<string, QuotaWindow>();
  for (const rawGroup of groups) {
    const buckets = object(rawGroup)?.buckets;
    if (!Array.isArray(buckets)) continue;
    sawBuckets = true;
    for (const rawBucket of buckets) {
      const bucket = object(rawBucket);
      const bucketId = typeof bucket?.id === "string" ? bucket.id.trim() : "";
      const known = BUCKETS[bucketId];
      if (!known?.reported || byBucket.has(bucketId)) continue;
      const usedPercent = usedPercentFromRemaining(bucket?.remaining_fraction);
      if (usedPercent === undefined) continue;
      const resetsAt = safeTimestamp(bucket?.reset_time);
      const period = windowPeriod(known.durationMs, "catalog", resetsAt);
      byBucket.set(bucketId, {
        id: known.id,
        ...(known.scope ? { scope: known.scope } : {}),
        label: known.label,
        usedPercent,
        ...(resetsAt === undefined ? {} : { resetsAt }),
        ...(period === undefined ? {} : { period }),
      });
    }
  }
  if (!sawBuckets) return null;
  const windows = BUCKET_ORDER.flatMap((bucketId) => {
    const window = byBucket.get(bucketId);
    return window ? [window] : [];
  });
  return windows.length > 0 ? windows : null;
}

/**
 * Decode one `agy -p "/usage" --output-format json` payload.
 *
 * A missing `command.data.groups[].buckets` array, `num_turns` other than 0,
 * or a non-SUCCESS status is not a reading. Unknown bucket ids are skipped.
 * The not-signed-in ERROR string is classified by {@link classifyAgyUsagePayload}.
 */
export function parseAntigravityQuotaSummary(payload: unknown): readonly QuotaWindow[] | null {
  const classified = classifyAgyUsagePayload(payload);
  return classified.status === "ok" ? classified.windows : null;
}

type UsageClassification =
  | { readonly status: "ok"; readonly windows: readonly QuotaWindow[] }
  | { readonly status: "signed_out" }
  | { readonly status: "error"; readonly message: string };

/**
 * Not-signed-in detection for a finished /usage payload. stderr is handled
 * earlier, in {@link runAgy}, with the same phrase constant.
 */
function classifyAgyUsagePayload(payload: unknown): UsageClassification {
  const root = object(payload);
  if (!root) return usageFailure();
  if (root.status === "ERROR" && root.error === AGY_AUTH_FAILED_ERROR) return { status: "signed_out" };
  if (root.status !== "SUCCESS" || root.num_turns !== 0) return usageFailure();
  const windows = mapReportedBuckets(root);
  if (!windows) return usageFailure();
  return { status: "ok", windows };
}

function usageFailure(): { readonly status: "error"; readonly message: string } {
  return { status: "error", message: "agy /usage failed" };
}

/**
 * Read Antigravity usage by asking the user's agy CLI.
 *
 * The activation knob (a later change) decides whether Fleet calls this.
 * This function always spawns, on every platform, and never reads agy's
 * credential store. A missing binary or a not-signed-in CLI is `signed_out`.
 * The result carries neither `method` nor `plan`.
 */
export async function fetchAntigravityUsage(deps: AntigravityQuotaDeps = {}): Promise<ProviderResult> {
  const credentialDeps = deps.credentials ?? defaultCredentialDeps;
  const now = deps.now ?? Date.now;
  const statPath = deps.stat ?? nodeStat;
  const spawnImpl = deps.spawn ?? (nodeSpawn as AntigravityCliSpawn);
  const command = optionalTrimmedString(credentialDeps.env.FLEET_ANTIGRAVITY_CLI) ?? "agy";
  const located = await locateAgy(command, credentialDeps.platform, credentialDeps.env, statPath);
  if (!located) return { status: "signed_out" };

  const cacheKey = `${located.path}\0${located.mtimeMs}`;
  let version = versionCache?.key === cacheKey ? versionCache.version : undefined;
  if (versionCache?.key !== cacheKey) {
    let run: AgyRun;
    try {
      run = await runAgy(spawnImpl, located.path, VERSION_ARGS, credentialDeps.env);
    } catch (error) {
      if (isEnoent(error)) return { status: "signed_out" };
      return { status: "error", message: "agy --version failed" };
    }
    if (run.stderrMatchedAuth) return { status: "signed_out" };
    if (run.timedOut || run.truncated || run.code !== 0) {
      return { status: "error", message: "agy --version failed" };
    }
    version = parseAgyVersion(run.stdout);
    versionCache = { key: cacheKey, version };
  }
  if (!version || !versionAtLeast(version, MIN_AGY_VERSION)) {
    return { status: "error", message: "agy 1.1.11 or newer is required" };
  }

  let usage: AgyRun;
  try {
    usage = await runAgy(spawnImpl, located.path, USAGE_ARGS, credentialDeps.env);
  } catch (error) {
    if (isEnoent(error)) return { status: "signed_out" };
    return usageFailure();
  }
  if (usage.stderrMatchedAuth) return { status: "signed_out" };
  if (usage.timedOut || usage.truncated) return usageFailure();
  let payload: unknown;
  try {
    payload = JSON.parse(usage.stdout);
  } catch {
    return usageFailure();
  }
  const classified = classifyAgyUsagePayload(payload);
  if (classified.status !== "ok") return classified;
  if (usage.code !== 0) return usageFailure();
  return { status: "ok", windows: classified.windows, fetchedAt: now() };
}
