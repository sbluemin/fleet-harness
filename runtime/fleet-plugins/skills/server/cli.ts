import { execFile } from "node:child_process";
import os from "node:os";

// ─── types ───────────────────────────────────────────────────────────────────

export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type CliExecutor = (
  args: string[],
  opts: { cwd: string; timeout: number; onChunk?: (chunk: string) => void },
) => Promise<CliResult>;

// ─── constants ───────────────────────────────────────────────────────────────

export const SKILLS_CLI_SPEC = "skills@1.5.14";

const ANSI_RE = /(\x9B|\x1B\[)[0-?]*[ -/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B[^[\x9B\]]|\x9C/g;

// ─── functions ───────────────────────────────────────────────────────────────

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export function defaultCwd(): string {
  return os.homedir();
}

export function createDefaultExecutor(): CliExecutor {
  return (args, { cwd, timeout, onChunk }) =>
    new Promise((resolve, reject) => {
      const child = execFile("npx", ["-y", SKILLS_CLI_SPEC, ...args], {
        shell: false,
        cwd,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      });

      const stdoutParts: string[] = [];
      const stderrParts: string[] = [];

      child.stdout?.on("data", (chunk: Buffer) => {
        const s = chunk.toString();
        stdoutParts.push(s);
        onChunk?.(s);
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const s = chunk.toString();
        stderrParts.push(s);
        onChunk?.(s);
      });

      child.on("close", (code) => {
        resolve({
          stdout: stdoutParts.join(""),
          stderr: stderrParts.join(""),
          exitCode: code ?? 1,
        });
      });

      child.on("error", reject);
    });
}
