import { execFile } from "node:child_process";

import { resolvePathBinary, type ResolvedBinary } from "@dotobokuri/core-process";
import { getFleetDataDir, type AuthService } from "@dotobokuri/core-infra";

import { AUTH_CLI_DEFINITIONS } from "./auth/login-flow.js";
import { readFleetCliRelease, type FleetCliRelease } from "./release.js";
import { createConsolePaths } from "../core/host/paths.js";
import { runConsoleStatus } from "../core/host/console-lifecycle.js";

const CLAUDE_COMMAND = "claude";
const SEMVER_PATTERN = /(\d+\.\d+\.\d+)/;
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const DOCTOR_HELP_TEXT = `fleet doctor — Diagnose Fleet

Usage:
  fleet doctor
`;

export interface DoctorIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface DoctorDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly release?: FleetCliRelease;
  readonly authService: Pick<AuthService, "listProviderIds">;
  readonly resolveBinary?: (command: string, env: NodeJS.ProcessEnv) => ResolvedBinary | undefined;
  readonly runVersion?: (bin: string, args: readonly string[]) => Promise<string>;
  readonly readConsoleStatus?: () => Promise<string>;
  readonly dataDir?: string;
  readonly lockFile?: string;
}

export async function dispatchDoctorCommand(
  argv: readonly string[],
  io: DoctorIo,
  deps: DoctorDeps,
): Promise<number> {
  const extra = argv[1];
  if (extra === "--help" || extra === "-h") {
    io.stdout.write(DOCTOR_HELP_TEXT);
    return 0;
  }
  if (extra !== undefined) {
    io.stderr.write(`Unknown fleet doctor command: ${extra}\n`);
    io.stdout.write(DOCTOR_HELP_TEXT);
    return 1;
  }
  io.stdout.write(`${await buildFleetDoctorText(deps)}\n`);
  return 0;
}

export async function buildFleetDoctorText(deps: DoctorDeps): Promise<string> {
  const env = deps.env ?? process.env;
  const release = deps.release ?? readFleetCliRelease();
  const dataDir = deps.dataDir ?? getFleetDataDir(env);
  const lockFile = deps.lockFile ?? createConsolePaths({ env }).lockFile;
  const resolveBinary = deps.resolveBinary ?? ((command, processEnv) => resolvePathBinary(command, processEnv));
  const runVersion = deps.runVersion ?? execFileVersion;
  const readConsoleStatus = deps.readConsoleStatus ?? runConsoleStatus;

  const signedIn = new Set(await deps.authService.listProviderIds());
  const binary = await describeClaudeBinary(resolveBinary(CLAUDE_COMMAND, env), runVersion);
  const consoleLine = firstLine(await readConsoleStatus());

  return [
    formatRow("package", `@dotobokuri/fleet-console ${release.version} (${release.channel})`),
    formatRow("data", dataDir),
    formatRow("binary", binary),
    formatRow("kimi", signedIn.has(AUTH_CLI_DEFINITIONS.kimi.providerId) ? "signed in" : "signed out"),
    formatRow("opencode", signedIn.has(AUTH_CLI_DEFINITIONS.opencode.providerId) ? "signed in" : "signed out"),
    formatRow("console", stripConsolePrefix(consoleLine)),
    formatRow("lock", lockFile),
  ].join("\n");
}

async function describeClaudeBinary(
  resolved: ResolvedBinary | undefined,
  runVersion: (bin: string, args: readonly string[]) => Promise<string>,
): Promise<string> {
  if (!resolved) return `${CLAUDE_COMMAND} (not on PATH)`;
  try {
    const output = await runVersion(resolved.bin, [...resolved.prefixArgs, "--version"]);
    const version = output.match(SEMVER_PATTERN)?.[1];
    return version ? `${resolved.bin} ${version}` : `${resolved.bin} (version unknown)`;
  } catch {
    return `${resolved.bin} (version unknown)`;
  }
}

function execFileVersion(bin: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, [...args], { timeout: VERSION_PROBE_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(`${stdout}${stderr}`);
    });
  });
}

function formatRow(key: string, value: string): string {
  return `${key.padEnd(10)}${value}`;
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}

function stripConsolePrefix(line: string): string {
  return line.replace(/^Fleet Console server:\s*/, "");
}
