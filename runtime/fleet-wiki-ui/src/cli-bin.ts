import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findLocalCliMjs, main } from "./cli.js";

const TRAMPOLINE_ENV = "FLEET_WIKI_TRAMPOLINED";
const SIGNAL_EXIT_FALLBACK_MS = 1000;

maybeTrampolineToLocalCli();
await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

function maybeTrampolineToLocalCli(): void {
  if (process.env[TRAMPOLINE_ENV] === "1") return;
  const localCli = findLocalCliMjs(process.cwd());
  if (!localCli) return;

  const currentCli = fileURLToPath(import.meta.url);
  if (path.resolve(localCli) === path.resolve(currentCli)) return;
  if (!isSameGitCommonDir(localCli, currentCli)) return;

  const cyan = process.stderr.isTTY ? "\x1b[36m" : "";
  const reset = process.stderr.isTTY ? "\x1b[0m" : "";
  process.stderr.write(`${cyan}fleet-wiki: redirecting to ${localCli}${reset}\n`);

  const result = spawnSync(process.execPath, [localCli, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, [TRAMPOLINE_ENV]: "1" },
  });
  if (result.error) {
    process.stderr.write(`fleet-wiki: trampoline failed: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    setTimeout(() => process.exit(1), SIGNAL_EXIT_FALLBACK_MS);
    return;
  }
  process.exit(result.status ?? 1);
}

function isSameGitCommonDir(candidateCli: string, currentCli: string): boolean {
  const candidateCommonDir = gitCommonDir(path.dirname(candidateCli));
  const currentCommonDir = gitCommonDir(path.dirname(currentCli));
  return candidateCommonDir !== null && currentCommonDir !== null && candidateCommonDir === currentCommonDir;
}

function gitCommonDir(cwd: string): string | null {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    return null;
  }
  const rawCommonDir = result.stdout.trim();
  if (!rawCommonDir) {
    return null;
  }
  return path.resolve(cwd, rawCommonDir);
}
