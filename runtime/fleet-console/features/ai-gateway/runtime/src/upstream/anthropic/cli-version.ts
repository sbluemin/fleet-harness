import fs from "node:fs/promises";
import path from "node:path";

import { defaultCredentialDeps, type CredentialResolverDeps } from "../../transport/credentials.js";

/**
 * The Claude Code version Fleet claims when it reads the subscription usage endpoint.
 *
 * `/api/oauth/usage` answers the usage-limit reset block (`cedar_ember`) only to a caller that
 * identifies as the Claude Code CLI, and version-gates it: `claude-cli/2.1.0` is answered
 * `ineligible_reason: "cli_version"` while the installed `2.1.280` receives its grants — measured
 * 2026-09-23. A constant baked into Fleet only ages against that floor, so the number is read
 * from the installation the credentials already belong to.
 *
 * Resolution order, cheapest first, each an artifact the official CLI owns:
 *
 * 1. `~/.local/bin/claude` — the native installer's symlink, whose target is
 *    `~/.local/share/claude/versions/<version>`. POSIX only.
 * 2. `~/.local/bin/claude[.exe]` run directly — the native install on every platform.
 * 3. `claude --version` from `PATH` — for npm or Homebrew installs. A Windows npm `.cmd` shim is
 *    refused by `execFile` without a shell; that falls through rather than being worked around.
 * 4. {@link CLAUDE_CLI_FALLBACK_VERSION} — the usage windows never depend on the version, so a
 *    stale number costs at most the reset block, never the snapshot.
 */
export const CLAUDE_CLI_FALLBACK_VERSION = "2.1.280";

/** `2.1.280 (Claude Code)`, and the bare `2.1.280` the installer's version directory is named. */
const VERSION_PATTERN = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/;
const VERSION_EXEC_TIMEOUT_MS = 2_000;

export interface ResolveClaudeCliVersionOptions {
  readonly deps?: CredentialResolverDeps;
  readonly readLink?: (filePath: string) => Promise<string>;
}

function versionFrom(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return VERSION_PATTERN.exec(value)?.[1];
}

async function fromInstallerSymlink(
  file: string,
  readLink: (filePath: string) => Promise<string>,
): Promise<string | undefined> {
  try {
    return versionFrom(path.basename(await readLink(file)));
  } catch {
    return undefined;
  }
}

async function fromCommand(deps: CredentialResolverDeps, file: string): Promise<string | undefined> {
  try {
    return versionFrom(await deps.execFile(file, ["--version"], { timeout: VERSION_EXEC_TIMEOUT_MS }));
  } catch {
    return undefined;
  }
}

/**
 * Resolved on every usage read rather than once per process: the CLI updates itself in the
 * background, and a floor raised past a cached number would silently hide the user's resets
 * until Console restarts. The symlink read that answers the common case is one `readlink`.
 */
export async function resolveClaudeCliVersion(options: ResolveClaudeCliVersionOptions = {}): Promise<string> {
  const deps = options.deps ?? defaultCredentialDeps;
  const readLink = options.readLink ?? ((filePath: string) => fs.readlink(filePath));
  const bin = path.join(deps.homedir(), ".local", "bin", deps.platform === "win32" ? "claude.exe" : "claude");
  return (deps.platform === "win32" ? undefined : await fromInstallerSymlink(bin, readLink))
    ?? await fromCommand(deps, bin)
    ?? await fromCommand(deps, "claude")
    ?? CLAUDE_CLI_FALLBACK_VERSION;
}
