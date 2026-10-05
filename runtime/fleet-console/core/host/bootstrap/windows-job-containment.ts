import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ProcessContainmentPort, ProcessGroupContainment } from "@fleet-console/lifecycle";

/**
 * The Windows half of an owned group (docs/console-lifecycle-contract.md, "Children").
 *
 * One unnamed, non-inheritable job per group, `KILL_ON_JOB_CLOSE` only, no breakaway flag. The Console process is the
 * only holder of the job handle. koffi is required here, inside the load, and nowhere else: foundation stays free of
 * native bindings, and macOS and Linux never call this module's load.
 *
 * The pinned version is the one the Windows gates measured (M13, run 37373327684). A different installed version refuses
 * to load and the Console falls back to libuv; it does not run unmeasured bindings.
 */
export const WINDOWS_JOB_KOFFI_VERSION = "3.3.2";

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1;
/** AssignProcessToJobObject requires both. Query-limited lets the held handle also observe the leader. */
const PROCESS_ASSIGN_ACCESS = 0x0100 | 0x0001 | 0x1000;

/**
 * Win64 LLP64 layout, the same one M13 set and queried on windows-2022 x64.
 * `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` is 144 bytes and `LimitFlags` sits at 16.
 * `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION` is 48 bytes and `ActiveProcesses` sits at 40.
 * arm64 Windows is the same width; a 32-bit process is refused rather than guessed.
 */
const WIN64_EXTENDED_LIMIT_SIZE = 144;
const WIN64_LIMIT_FLAGS_OFFSET = 16;
const WIN64_ACCOUNTING_SIZE = 48;
const WIN64_ACTIVE_PROCESSES_OFFSET = 40;

const SUPPORTED_ARCH = new Set(["x64", "arm64"]);

/** Why one group, or the whole port, could not be contained. The host records it; this module does not. */
export interface WindowsContainmentDegraded {
  readonly stage: "load" | "create" | "assign";
  readonly pid?: number;
  readonly error: unknown;
}

/**
 * The kernel calls, so a test can inject a failure without loading koffi. Every method may throw; the port turns that
 * into a degraded group and never throws out of `contain`.
 */
export interface WindowsJobBindings {
  createJob(): unknown;
  /** Sets `KILL_ON_JOB_CLOSE` and nothing else. False when the kernel refuses. */
  setKillOnJobClose(job: unknown): boolean;
  /** A non-inheritable process handle, or null. The caller holds it until the group is dropped. */
  openProcess(pid: number): unknown;
  assign(job: unknown, processHandle: unknown): boolean;
  /** `ActiveProcesses`, or null when the query fails. Null means "still has members" to the caller. */
  activeProcesses(job: unknown): number | null;
  terminate(job: unknown): boolean;
  close(handle: unknown): void;
  lastError(): number;
}

interface KoffiLoaded {
  func(convention: string, name: string, result: unknown, args: readonly unknown[]): (...args: never[]) => unknown;
}

interface KoffiModule {
  load(file: string): KoffiLoaded;
  pointer(type: string): unknown;
  out(pointerType: unknown): unknown;
  errno?: () => number;
}

/**
 * Loads koffi and kernel32, checks the pinned version, and proves the limit struct once. Throws on any failure: the
 * caller records one `containment_degraded` and builds the registry with no port.
 */
export function loadWindowsJobBindings(moduleUrl: string = import.meta.url): WindowsJobBindings {
  if (process.platform !== "win32") throw new Error("Windows job containment is only loaded on win32");
  if (!SUPPORTED_ARCH.has(process.arch)) {
    throw new Error(`Windows job containment needs a 64-bit process (got ${process.arch})`);
  }
  const requireKoffi = createRequire(resolveConsolePackageBase(moduleUrl));
  const koffi = requireKoffi("koffi") as KoffiModule;
  const version = readKoffiVersion(requireKoffi);
  if (version !== WINDOWS_JOB_KOFFI_VERSION) {
    throw new Error(`koffi ${version} is loaded; Windows job containment requires ${WINDOWS_JOB_KOFFI_VERSION}`);
  }
  const bindings = bindKernel(koffi);
  const probe = bindings.createJob();
  if (!probe) throw new Error(`CreateJobObjectW failed: ${bindings.lastError()}`);
  try {
    if (!bindings.setKillOnJobClose(probe)) throw new Error(`SetInformationJobObject failed: ${bindings.lastError()}`);
  } finally {
    bindings.close(probe);
  }
  return bindings;
}

/** A port whose `contain` never throws. A failed create or assign closes what it opened and reports that one group. */
export function createWindowsJobContainment(bindings: WindowsJobBindings, onDegraded: (detail: WindowsContainmentDegraded) => void): ProcessContainmentPort {
  return {
    contain(pid) {
      let job: unknown = null;
      let processHandle: unknown = null;
      try {
        job = bindings.createJob();
        if (!job) return degrade(onDegraded, bindings, "create", pid, job, processHandle);
        if (!bindings.setKillOnJobClose(job)) return degrade(onDegraded, bindings, "create", pid, job, processHandle);
        processHandle = bindings.openProcess(pid);
        if (!processHandle) return degrade(onDegraded, bindings, "assign", pid, job, processHandle);
        if (!bindings.assign(job, processHandle)) return degrade(onDegraded, bindings, "assign", pid, job, processHandle);
        return holdGroup(bindings, job, processHandle);
      } catch (error) {
        closeQuiet(bindings, processHandle);
        closeQuiet(bindings, job);
        onDegraded({ stage: "create", pid, error });
        return null;
      }
    },
  };
}

function degrade(onDegraded: (detail: WindowsContainmentDegraded) => void, bindings: WindowsJobBindings, stage: "create" | "assign", pid: number, job: unknown, processHandle: unknown): null {
  const error = new Error(`Windows job ${stage} failed for pid ${pid}: ${bindings.lastError()}`);
  closeQuiet(bindings, processHandle);
  closeQuiet(bindings, job);
  onDegraded({ stage, pid, error });
  return null;
}

function holdGroup(bindings: WindowsJobBindings, job: unknown, processHandle: unknown): ProcessGroupContainment {
  let closed = false;
  const hasMembers = (): boolean => {
    if (closed) return false;
    try {
      const active = bindings.activeProcesses(job);
      // A failed query is not proof the job is empty. Closing it would drop members the kernel would have killed.
      if (active === null) return true;
      return active > 0;
    } catch {
      return true;
    }
  };
  return {
    hasMembers,
    terminate() {
      if (closed) return false;
      try { return bindings.terminate(job); }
      catch { return false; }
    },
    close() {
      if (closed || hasMembers()) return;
      closed = true;
      closeQuiet(bindings, processHandle);
      closeQuiet(bindings, job);
    },
  };
}

function closeQuiet(bindings: WindowsJobBindings, handle: unknown): void {
  if (!handle) return;
  try { bindings.close(handle); }
  catch { /* A handle that will not close dies with the process, which still runs KILL_ON_JOB_CLOSE. */ }
}

function bindKernel(koffi: KoffiModule): WindowsJobBindings {
  const kernel32 = koffi.load("kernel32.dll");
  const u8ptr = koffi.pointer("uint8");
  const u32ptr = koffi.pointer("uint32");
  const specs = [
    ["CreateJobObjectW", "void *", ["void *", "void *"]],
    ["SetInformationJobObject", "int", ["void *", "int", u8ptr, "uint32"]],
    ["QueryInformationJobObject", "int", ["void *", "int", u8ptr, "uint32", koffi.out(u32ptr)]],
    ["AssignProcessToJobObject", "int", ["void *", "void *"]],
    ["OpenProcess", "void *", ["uint32", "int", "uint32"]],
    ["TerminateJobObject", "int", ["void *", "uint32"]],
    ["CloseHandle", "int", ["void *"]],
    ["GetLastError", "uint32", []],
  ] as const;
  const bound = new Map<string, (...args: never[]) => unknown>();
  for (const [name, result, args] of specs) {
    bound.set(name, kernel32.func("__stdcall", name, result, args));
  }
  const call = (name: string, args: readonly unknown[]): unknown => {
    const fn = bound.get(name);
    if (!fn) throw new Error(`kernel32 binding ${name} is missing`);
    return fn(...args as never[]);
  };
  const lastError = (): number => {
    const saved = Number(typeof koffi.errno === "function" ? koffi.errno() : 0);
    if (saved) return saved >>> 0;
    return Number(call("GetLastError", [])) >>> 0;
  };
  return {
    createJob: () => call("CreateJobObjectW", [null, null]),
    setKillOnJobClose(job) {
      const buf = Buffer.alloc(WIN64_EXTENDED_LIMIT_SIZE);
      buf.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, WIN64_LIMIT_FLAGS_OFFSET);
      return Boolean(call("SetInformationJobObject", [job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, buf, buf.length]));
    },
    // bInheritHandle is 0: the leader handle stays in this process, which is what keeps its pid from being reused.
    openProcess: (pid) => call("OpenProcess", [PROCESS_ASSIGN_ACCESS, 0, pid]),
    assign: (job, processHandle) => Boolean(call("AssignProcessToJobObject", [job, processHandle])),
    activeProcesses(job) {
      const buf = Buffer.alloc(WIN64_ACCOUNTING_SIZE);
      const returned = [0];
      const ok = call("QueryInformationJobObject", [job, JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION, buf, buf.length, returned]);
      if (!ok) return null;
      return buf.readUInt32LE(WIN64_ACTIVE_PROCESSES_OFFSET);
    },
    terminate: (job) => Boolean(call("TerminateJobObject", [job, 1])),
    close: (handle) => { call("CloseHandle", [handle]); },
    lastError,
  };
}

function isConsolePackage(manifestPath: string): boolean {
  if (!existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { readonly name?: unknown };
    return manifest.name === "@dotobokuri/fleet-console";
  } catch {
    return false;
  }
}

function readKoffiVersion(requireKoffi: NodeRequire): string {
  let dir = path.dirname(requireKoffi.resolve("koffi"));
  for (let depth = 0; depth < 6; depth += 1) {
    const manifestPath = path.join(dir, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { readonly name?: unknown; readonly version?: unknown };
      if (manifest.name === "koffi" && typeof manifest.version === "string") return manifest.version;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("koffi package.json was not found beside the loaded module");
}

/**
 * createRequire base for the Console package. The bundle lives in `dist/`, and koffi is a dependency of that package,
 * external the way node-pty is. Walks up from this file; `FLEET_CONSOLE_PACKAGE_ROOT` wins when the host has set it.
 */
function resolveConsolePackageBase(moduleUrl: string): string {
  const explicit = process.env.FLEET_CONSOLE_PACKAGE_ROOT;
  if (explicit && isConsolePackage(path.join(explicit, "package.json"))) return path.join(explicit, "package.json");
  let dir = path.dirname(fileURLToPath(moduleUrl));
  while (true) {
    const manifestPath = path.join(dir, "package.json");
    if (isConsolePackage(manifestPath)) return manifestPath;
    const parent = path.dirname(dir);
    if (parent === dir) return fileURLToPath(moduleUrl);
    dir = parent;
  }
}
