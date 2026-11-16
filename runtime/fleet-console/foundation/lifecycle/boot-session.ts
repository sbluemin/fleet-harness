import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * The OS boot this process belongs to, as `<platform>:<id>`.
 * macOS reads `kern.bootsessionuuid`, Linux `/proc/sys/kernel/random/boot_id`, and Windows the kernel `BootId`
 * registry value (`PrefetchParameters\BootId`).
 * A failure is null: callers then keep the ESRCH and `replaced` rules. The platform prefix keeps a lock written in
 * another namespace (a Linux Console read from Windows) from looking like a previous boot.
 */
const BOOT_SESSION_TEXT = /^[A-Za-z0-9._:-]{1,128}$/;
const WIN_PREFETCH_BOOT_ID_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters";

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

/**
 * Parses `reg.exe query ...\PrefetchParameters /v BootId` output. Returns the positive kernel boot id string,
 * or null when absent/zero/unreadable so callers fall back to ESRCH and `replaced`.
 */
export function parseWindowsBootIdRegOutput(output: string): string | null {
  const match = /^\s*BootId\s+REG_DWORD\s+(0x[0-9a-fA-F]+|\d+)\b/m.exec(output);
  if (!match) return null;
  const raw = match[1]!;
  const value = raw.toLowerCase().startsWith("0x") ? Number.parseInt(raw.slice(2), 16) : Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}

/**
 * Clock-independent kernel boot id from Windows `PrefetchParameters\BootId`.
 * A missing key, failed query, or uninitialized value returns null so the caller falls back to ESRCH.
 */
export function readWindowsBootId(
  query: (file: string, args: readonly string[]) => string = (file, args) => execFileSync(file, args, {
    encoding: "utf8",
    timeout: 1_000,
    windowsHide: true,
  }),
): string | null {
  try {
    const output = query("reg.exe", ["query", WIN_PREFETCH_BOOT_ID_KEY, "/v", "BootId"]);
    return parseWindowsBootIdRegOutput(String(output));
  } catch {
    return null;
  }
}
