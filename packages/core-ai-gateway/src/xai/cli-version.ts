import fs from "node:fs/promises";
import path from "node:path";

import {
  defaultCredentialDeps,
  optionalTrimmedString,
  type CredentialResolverDeps,
} from "../transport/credentials.js";

/**
 * The Grok CLI version Fleet claims when it talks to the CLI chat proxy.
 *
 * The proxy version-gates that endpoint: a request carrying no `x-grok-client-version`, or one
 * below its floor, is answered `426 {"error":"Your Grok CLI version (none) is outdated. Please
 * update to version 0.1.202 or later"}` — measured 2026-08-20. A constant baked into Fleet is a
 * value that only ages: the floor moves on the server's schedule and the CLI updates itself on
 * the user's, so the number is read from the installation instead.
 *
 * Resolution order, cheapest first, and every step is an artifact the official CLI itself owns:
 *
 * 1. `FLEET_XAI_CLI_VERSION` — an operator override for a machine with no CLI installed.
 * 2. `$GROK_HOME/bin/grok` — the installer's symlink, whose target is `grok-<version>`.
 * 3. `$GROK_HOME/.metadata_version` — stamped with its own version by every CLI run.
 * 4. `grok --version` — the authority, but a process spawn, so it is the last resort.
 * 5. {@link XAI_CLI_FALLBACK_CLIENT_VERSION} — better a stale number than none: the proxy
 *    rejects an absent header outright, while a low-but-present one at least fails with a
 *    message naming the floor.
 */
export const XAI_CLI_FALLBACK_CLIENT_VERSION = "1.0.5";

/** `grok 1.0.5 (5115b46bc909) [stable]`, and the bare `1.0.5` the marker file holds. */
const VERSION_PATTERN = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/;
const VERSION_EXEC_TIMEOUT_MS = 2_000;
const MAX_VERSION_FILE_BYTES = 256;

export interface ResolveXaiCliVersionOptions {
  readonly deps?: CredentialResolverDeps;
  readonly readLink?: (filePath: string) => Promise<string>;
}

/** The Grok CLI home the official installer and this resolver share. */
export function grokHomeDir(deps: CredentialResolverDeps): string {
  return optionalTrimmedString(deps.env.GROK_HOME) ?? path.join(deps.homedir(), ".grok");
}

function versionFrom(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return VERSION_PATTERN.exec(value)?.[1];
}

async function fromInstallerSymlink(
  home: string,
  readLink: (filePath: string) => Promise<string>,
): Promise<string | undefined> {
  try {
    // The link is relative (`grok -> grok-1.0.5`); only its basename carries the version.
    return versionFrom(path.basename(await readLink(path.join(home, "bin", "grok"))));
  } catch {
    return undefined;
  }
}

async function fromMetadataMarker(
  home: string,
  deps: CredentialResolverDeps,
): Promise<string | undefined> {
  try {
    return versionFrom(await deps.readBounded(path.join(home, ".metadata_version"), MAX_VERSION_FILE_BYTES));
  } catch {
    return undefined;
  }
}

async function fromCommand(deps: CredentialResolverDeps): Promise<string | undefined> {
  try {
    return versionFrom(await deps.execFile("grok", ["--version"], { timeout: VERSION_EXEC_TIMEOUT_MS }));
  } catch {
    return undefined;
  }
}

/** Resolve without consulting the process cache. Prefer {@link xaiCliClientVersion}. */
export async function resolveXaiCliClientVersion(
  options: ResolveXaiCliVersionOptions = {},
): Promise<string> {
  const deps = options.deps ?? defaultCredentialDeps;
  const readLink = options.readLink ?? ((filePath: string) => fs.readlink(filePath));
  const override = versionFrom(optionalTrimmedString(deps.env.FLEET_XAI_CLI_VERSION));
  if (override) return override;
  const home = grokHomeDir(deps);
  return await fromInstallerSymlink(home, readLink)
    ?? await fromMetadataMarker(home, deps)
    ?? await fromCommand(deps)
    ?? XAI_CLI_FALLBACK_CLIENT_VERSION;
}

let cached: Promise<string> | undefined;

/**
 * The resolved version, computed once per process.
 *
 * A CLI self-update mid-session moves the number, but the proxy only cares that the header is
 * present and above its floor — and the floor cannot rise past a version that is already
 * installed. Re-reading the filesystem on every turn buys nothing for that.
 */
export function xaiCliClientVersion(options: ResolveXaiCliVersionOptions = {}): Promise<string> {
  cached ??= resolveXaiCliClientVersion(options).catch(() => XAI_CLI_FALLBACK_CLIENT_VERSION);
  return cached;
}

/** Test seam: forget the resolved version. */
export function resetXaiCliClientVersion(): void {
  cached = undefined;
}
