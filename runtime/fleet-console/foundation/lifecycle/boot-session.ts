import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * The OS boot this process belongs to, as `<platform>:<id>`.
 * macOS reads `kern.bootsessionuuid`, Linux `/proc/sys/kernel/random/boot_id`, and Windows the last boot time.
 * A failure is null: callers then keep the ESRCH and `replaced` rules. The platform prefix keeps a lock written in
 * another namespace (a Linux Console read from Windows) from looking like a previous boot.
 */
const BOOT_SESSION_TEXT = /^[A-Za-z0-9._:-]{1,128}$/;

let cached: string | null | undefined;
let sourceOverride: (() => string | null) | undefined;

/** Test override. Pass undefined to restore the process cache. Not for production callers. */
export function setConsoleBootSessionSourceForTests(source: (() => string | null) | undefined): void {
  sourceOverride = source;
  cached = undefined;
}

/** The current OS boot session, cached for this process, or null when it cannot be read. */
export function currentConsoleBootSession(): string | null {
  if (sourceOverride) return normalizeBootSession(sourceOverride());
  if (cached === undefined) cached = readOsBootSession();
  return cached;
}

/** A boot-session id this contract will compare, or null when the value is absent or not that shape. */
export function normalizeBootSession(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return BOOT_SESSION_TEXT.test(trimmed) ? trimmed : null;
}

/**
 * True only when both ids are non-empty, name the same platform, and differ.
 * A missing record, an unreadable current boot, or a different platform is not a mismatch: those keep the old rules.
 */
export function bootSessionsDiffer(recorded: unknown, current: string | null): boolean {
  const recordedId = normalizeBootSession(recorded);
  const currentId = normalizeBootSession(current);
  if (recordedId === null || currentId === null) return false;
  const recordedPlatform = platformOf(recordedId);
  const currentPlatform = platformOf(currentId);
  if (recordedPlatform === null || recordedPlatform !== currentPlatform) return false;
  return recordedId !== currentId;
}

function platformOf(id: string): string | null {
  const index = id.indexOf(":");
  if (index <= 0) return null;
  return id.slice(0, index);
}

function readOsBootSession(): string | null {
  try {
    const raw = readRawBootId();
    const id = raw?.trim() ?? "";
    if (id.length === 0) return null;
    return normalizeBootSession(`${process.platform}:${id}`);
  } catch {
    return null;
  }
}

function readRawBootId(): string | null {
  if (process.platform === "darwin") {
    return execFileSync("sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", timeout: 1_000, windowsHide: true });
  }
  if (process.platform === "linux") {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8");
  }
  if (process.platform === "win32") return readWindowsBootId();
  return null;
}

/** Last boot time as UTC epoch seconds. A slow or failed query is null, and the caller falls back to ESRCH. */
function readWindowsBootId(): string | null {
  const script = "[DateTimeOffset]::new((Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime).ToUnixTimeSeconds()";
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 3_000,
    windowsHide: true,
  });
  const seconds = Number(String(output).trim());
  return Number.isSafeInteger(seconds) && seconds > 0 ? String(seconds) : null;
}
