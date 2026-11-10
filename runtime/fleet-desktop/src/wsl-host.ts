import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import path from "node:path";

/**
 * The one place Desktop talks to WSL. Everything here goes through `wsl.exe`, so a command acts inside one
 * distribution as one Linux user; nothing here ends a distribution (`--terminate`, `--shutdown`) or reads a Linux pid
 * as a Windows one.
 */
export interface WslDistro {
  readonly name: string;
  /** `wsl.exe --list --verbose` says Running. Asking never starts a distribution. */
  readonly running: boolean;
  readonly version: 1 | 2 | null;
}

export interface WslRunResult { readonly code: number | null; readonly stdout: string; readonly stderr: string; }

export interface WslHost {
  distros(): Promise<readonly WslDistro[]>;
  /** Runs a POSIX sh script, handed over on stdin so no quoting crosses `wsl.exe`. Starts a stopped distribution. */
  sh(distro: string, user: string | null, script: string, timeoutMs?: number): Promise<WslRunResult>;
  /**
   * Pipes a Windows-side file into `command` inside the distribution. An `archive` is re-emitted as a plain tar stream
   * first, because a minimal distribution has no xz. `command` travels as an argument and must be free of quotes.
   */
  pipe(distro: string, user: string, source: { readonly file: string } | { readonly archive: string }, command: string, timeoutMs?: number): Promise<WslRunResult>;
  /** The Windows path of a file inside a running distribution. Touching it starts a stopped distribution. */
  windowsPath(distro: string, linuxPath: string): string;
}

const DISTRO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
/** Utility distributions other products keep for themselves; they have no user to run a Console as. */
const UTILITY_DISTRO = /^(docker-desktop|rancher-desktop)/u;
const LIST_TIMEOUT_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const QUOTE_FREE = /^[A-Za-z0-9 _./:=@&>|+-]+$/u;

export function isUsableWslDistroName(name: string): boolean {
  return DISTRO_NAME.test(name) && !UTILITY_DISTRO.test(name);
}

/** `NAME STATE VERSION` rows; the default distribution's row starts with `*`. */
export function parseWslDistroList(output: string): readonly WslDistro[] {
  const distros: WslDistro[] = [];
  for (const line of output.replace(/\u0000/gu, "").split(/\r?\n/u).slice(1)) {
    const row = /^\*?\s*(\S+)\s+(\S+)\s+(\d)\s*$/u.exec(line);
    if (!row || !isUsableWslDistroName(row[1]!)) continue;
    distros.push({ name: row[1]!, running: row[2] === "Running", version: row[3] === "1" ? 1 : row[3] === "2" ? 2 : null });
  }
  return distros;
}

export function createWslHost(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): WslHost | null {
  if (platform !== "win32") return null;
  const system = path.win32.join(env.SystemRoot ?? env.WINDIR ?? "C:\\Windows", "System32");
  const wsl = path.win32.join(system, "wsl.exe");
  const tar = path.win32.join(system, "tar.exe");
  const target = (distro: string, user: string | null): string[] => {
    if (!isUsableWslDistroName(distro) || (user !== null && !/^[a-z_][a-z0-9_.-]{0,31}$/u.test(user))) throw new Error("wsl_target_invalid");
    return ["-d", distro, ...(user === null ? [] : ["-u", user])];
  };

  function run(args: readonly string[], input: { readonly text?: string; readonly file?: string; readonly archive?: string }, timeoutMs: number, encoding: BufferEncoding = "utf8"): Promise<WslRunResult> {
    return new Promise((resolve) => {
      const child = spawn(wsl, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const feeder = input.archive ? spawn(tar, ["-cf", "-", `@${input.archive}`], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }) : null;
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let settled = false;
      const finish = (code: number | null, note = ""): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        feeder?.kill();
        resolve({ code, stdout: Buffer.concat(out).toString(encoding), stderr: Buffer.concat(err).toString("utf8") + note });
      };
      // A command that outlives its budget is only abandoned: the wsl.exe that carried it ends, nothing inside is hunted.
      const timer = setTimeout(() => { child.kill(); finish(null, "\nwsl_command_timed_out"); }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", (error) => finish(null, `\n${error.message}`));
      child.on("close", (code) => finish(code));
      child.stdin.on("error", () => { /* The command ended before it read everything; its exit code tells. */ });
      if (feeder) feeder.stdout.pipe(child.stdin);
      else if (input.file) createReadStream(input.file).on("error", () => child.stdin.end()).pipe(child.stdin);
      else child.stdin.end(input.text ?? "");
    });
  }

  return {
    async distros() {
      const listed = await run(["--list", "--verbose"], {}, LIST_TIMEOUT_MS, "utf16le");
      return listed.code === 0 ? parseWslDistroList(listed.stdout) : [];
    },
    sh: (distro, user, script, timeoutMs = DEFAULT_TIMEOUT_MS) => run([...target(distro, user), "-e", "sh", "-s"], { text: script }, timeoutMs),
    pipe(distro, user, source, command, timeoutMs = DEFAULT_TIMEOUT_MS) {
      if (!QUOTE_FREE.test(command)) throw new Error("wsl_command_invalid");
      return run([...target(distro, user), "-e", "sh", "-c", command], source, timeoutMs);
    },
    windowsPath(distro, linuxPath) {
      if (!isUsableWslDistroName(distro) || !linuxPath.startsWith("/")) throw new Error("wsl_target_invalid");
      return path.win32.join("\\\\wsl.localhost", distro, ...linuxPath.split("/").filter(Boolean));
    },
  };
}
