import { execFile } from "node:child_process";

import { PROCESS_START_MARGIN_MS, PROCESS_TABLE_TIMEOUT_MS, LOCK_AUTHOR_REPLACED_MARGIN_MS } from "@fleet-console/protocol/lifecycle";

/** Only ESRCH means the process is gone. A live pid, EPERM, and any undecidable error all count as alive. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code !== "ESRCH";
  }
}

const PS_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// PowerShell starts slowly on a cold machine; a missing start time only costs the start-time proof, never a wrong signal.
const WINDOWS_START_TIME_TIMEOUT_MS = 10_000;

/**
 * The start time of `pid` (epoch ms, rounded down to the second), or null when the process is gone or its start time
 * cannot be read. macOS and Linux use `ps -o lstart`; Windows uses PowerShell `Get-Process`. macOS keeps microsecond start
 * times only in sysctl kern.proc, which Node cannot read, so the shared `ps` format is used on both.
 */
export function readProcessStartTime(pid: number, env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(null);
  if (process.platform === "win32") return readWindowsProcessStartTime(pid, env);
  return new Promise((resolve) => {
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], {
      // The proof depends on both: LC_ALL=C fixes the English date format parsed below, and TZ=UTC fixes Date.UTC's reading.
      // Without TZ the start time shifts by the local offset and every margin above loses its meaning.
      env: { PATH: env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
      timeout: PROCESS_TABLE_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout) => {
      resolve(error ? null : parsePsLstartUtc(String(stdout)));
    });
  });
}

/**
 * The start time of `pid` when it can serve as an identity mark: only a process that started at least
 * PROCESS_START_MARGIN_MS before `provenAt` (the moment its identity was proven) can be the process that was proven. If the
 * pid is reused later, the new process starts after `provenAt` and its start time differs.
 */
export async function captureProvenProcessStart(pid: number, provenAt: number, env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
  const startedAt = await readProcessStartTime(pid, env);
  return startedAt !== null && startedAt + PROCESS_START_MARGIN_MS <= provenAt ? startedAt : null;
}

/** Whether the process now running as the lock pid started after that lock was written. Evidence of the author's death never goes stale. */
export async function isLockAuthorReplaced(lock: { readonly pid: number; readonly startedAt: unknown }, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (typeof lock.startedAt !== "number" || !Number.isFinite(lock.startedAt)) return false;
  const startedAt = await readProcessStartTime(lock.pid, env);
  return startedAt !== null && startedAt > lock.startedAt + LOCK_AUTHOR_REPLACED_MARGIN_MS;
}

/**
 * Windows has no `ps` and Node exposes no start time. PowerShell prints UTC epoch ms as an integer, so neither the local
 * time zone nor the culture's date format matters; the value is rounded down to the second like `ps`. PowerShell needs the
 * Windows environment (SystemRoot and friends), so the caller's env is passed through.
 */
function readWindowsProcessStartTime(pid: number, env: NodeJS.ProcessEnv): Promise<number | null> {
  const script = `[DateTimeOffset]::new((Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`;
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env, timeout: WINDOWS_START_TIME_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      const millis = Number(String(stdout).trim());
      resolve(error || !Number.isSafeInteger(millis) || millis <= 0 ? null : Math.floor(millis / 1_000) * 1_000);
    });
  });
}

function parsePsLstartUtc(output: string): number | null {
  const match = /^[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(output.trim());
  if (!match) return null;
  const month = PS_MONTHS.indexOf(match[1]!);
  if (month < 0) return null;
  return Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]));
}
