import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { SessionHostPlatform, SessionHostProcess } from "@fleet-console/lifecycle/session-host";
import { SESSION_HOST_POLL_MS } from "@fleet-console/protocol/session-host";
import { createOwnedProcessRegistry, type OwnedProcessRegistry } from "@fleet-console/lifecycle";
import { createWindowsJobContainment, loadWindowsJobBindings } from "./windows-job-containment.js";

interface NativeLibrary { func(convention: string, name: string, result: unknown, args: readonly unknown[]): (...args: unknown[]) => unknown; }
interface NativeModule {
  load(file: string): NativeLibrary;
  pointer(type: string): unknown;
  decode: { (value: unknown, type: string): unknown; string16(value: unknown): string };
}
const CREATE_SUSPENDED = 0x00000004;
const DETACHED_PROCESS = 0x00000008;
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
const STILL_ACTIVE = 259;

/** Win64 전용 조합부. 독립성을 증명하지 못한 child는 첫 instruction 전에 종료한다. */
export function createWindowsSessionPlatform(consoleProcesses?: OwnedProcessRegistry): SessionHostPlatform | undefined {
  if (process.platform !== "win32") return undefined;
  const bindings = loadWindowsJobBindings(); // 기존 native 버전·구조 검증과 같은 pin을 적용한다.
  const boundProcesses = consoleProcesses ?? createOwnedProcessRegistry({ containment: createWindowsJobContainment(bindings, () => {}) });
  const koffi = createRequire(import.meta.url)("koffi") as NativeModule;
  const kernel = koffi.load("kernel32.dll"); const advapi = koffi.load("advapi32.dll");
  const ptr = "void *"; const byte = koffi.pointer("uint8");
  const fn = (lib: NativeLibrary, name: string, ret: unknown, args: readonly unknown[]) => lib.func("__stdcall", name, ret, args);
  const current = fn(kernel, "GetCurrentProcess", ptr, []);
  const close = fn(kernel, "CloseHandle", "int", [ptr]);
  const localFree = fn(kernel, "LocalFree", ptr, [ptr]);
  const inJob = fn(kernel, "IsProcessInJob", "int", [ptr, ptr, byte]);
  const create = fn(kernel, "CreateProcessW", "int", [ptr, byte, ptr, ptr, "int", "uint32", ptr, ptr, byte, byte]);
  const resume = fn(kernel, "ResumeThread", "uint32", [ptr]);
  const terminate = fn(kernel, "TerminateProcess", "int", [ptr, "uint32"]);
  const exitCode = fn(kernel, "GetExitCodeProcess", "int", [ptr, byte]);
  const getError = fn(kernel, "GetLastError", "uint32", []);
  const openToken = fn(advapi, "OpenProcessToken", "int", [ptr, "uint32", byte]);
  const tokenInfo = fn(advapi, "GetTokenInformation", "int", [ptr, "int", byte, "uint32", byte]);
  const security = fn(advapi, "GetNamedSecurityInfoW", "uint32", [ptr, "int", "uint32", byte, ptr, ptr, ptr, byte]);
  const equalSid = fn(advapi, "EqualSid", "int", [ptr, ptr]);
  const sidString = fn(advapi, "ConvertSidToStringSidW", "int", [ptr, byte]);
  const convertSecurity = fn(advapi, "ConvertStringSecurityDescriptorToSecurityDescriptorW", "int", [ptr, "uint32", byte, ptr]);
  const setSecurity = fn(advapi, "SetFileSecurityW", "int", [ptr, "uint32", ptr]);
  const pointer = (buffer: Buffer) => koffi.decode(buffer, "void *");
  const wide = (value: string) => Buffer.from(value + "\0", "utf16le");
  const error = (name: string) => new Error(`${name}:${Number(getError())}`);
  const token = Buffer.alloc(8); if (!openToken(current(), 0x0008, token)) throw error("session_token_open");
  const user = Buffer.alloc(4096); const needed = Buffer.alloc(4);
  try { if (!tokenInfo(pointer(token), 1, user, user.length, needed)) throw error("session_token_user"); }
  finally { close(pointer(token)); }
  const userSid = pointer(user);
  const converted = Buffer.alloc(8); if (!sidString(userSid, converted)) throw error("session_sid_string");
  let sid: string;
  // converted는 LPWSTR 셀이고 pointer(converted)는 문자열 자체다. str16으로 재역참조하지 않는다.
  try { sid = koffi.decode.string16(pointer(converted)); } finally { localFree(pointer(converted)); }
  const independent = (handle: unknown): void => {
    const member = Buffer.alloc(4);
    if (!inJob(handle, null, member)) throw error("session_job_query_failed");
    if (member.readUInt32LE(0) !== 0) throw new Error("session_host_job_bound");
  };
  const owns = (file: string): boolean => {
    const owner = Buffer.alloc(8); const descriptor = Buffer.alloc(8);
    const result = Number(security(wide(file), 1, 1, owner, null, null, null, descriptor));
    if (result !== 0) return false;
    try { return Boolean(equalSid(pointer(owner), pointer(user))); } finally { localFree(pointer(descriptor)); }
  };
  return {
    assertIndependent: () => independent(current()),
    owns,
    spawnConsoleOwned(command, args, env) {
      const child = boundProcesses.spawn({ command, args, env, owner: "session-host" });
      child.stdout?.resume(); child.stderr?.resume();
      if (!boundProcesses.groups().some((group) => group.pgid === child.pid)) {
        child.kill("SIGKILL"); throw new Error("session_console_containment_unavailable");
      }
      return child;
    },
    protectDirectory(file) {
      if (!owns(file)) throw new Error("session_directory_owner_unverified");
      const descriptor = Buffer.alloc(8);
      // 현재 사용자와 SYSTEM만 접근하고, 하위 파일·디렉터리도 같은 DACL을 상속한다.
      if (!convertSecurity(wide(`D:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;SY)`), 1, descriptor, null)) throw error("session_directory_acl_build");
      try { if (!setSecurity(wide(file), 0x80000004, pointer(descriptor))) throw error("session_directory_acl_set"); }
      finally { localFree(pointer(descriptor)); }
    },
    spawnIndependent(command, args, env) {
      const environment = Buffer.from(Object.entries(env).filter(([key, value]) => value !== undefined && !key.includes("=")).sort(([a], [b]) => a.toUpperCase().localeCompare(b.toUpperCase())).map(([key, value]) => `${key}=${value}`).join("\0") + "\0\0", "utf16le");
      const commandLine = [command, ...args].map(quoteWindowsArg).join(" ");
      const spawn = (breakaway: boolean): { handle: unknown; thread: unknown; pid: number } | null => {
        const startup = Buffer.alloc(104); startup.writeUInt32LE(104, 0);
        const processInfo = Buffer.alloc(24);
        const flags = CREATE_SUSPENDED | DETACHED_PROCESS | CREATE_UNICODE_ENVIRONMENT | (breakaway ? CREATE_BREAKAWAY_FROM_JOB : 0);
        if (!create(wide(command), wide(commandLine), null, null, 0, flags, environment, null, startup, processInfo)) return null;
        return { handle: pointer(processInfo), thread: pointer(processInfo.subarray(8)), pid: processInfo.readUInt32LE(16) };
      };
      let child = spawn(true);
      if (!child) {
        // breakaway 거부 후에도 silent-breakaway 여부를 suspended child에서 증명한다.
        child = spawn(false);
        if (!child) throw Object.assign(error("session_independent_create_failed"), { code: "SESSION_INDEPENDENCE_UNAVAILABLE" });
      }
      try {
        independent(child.handle);
        if (Number(resume(child.thread)) === 0xffffffff) throw error("session_independent_resume_failed");
      } catch (failure) {
        terminate(child.handle, 1); close(child.thread); close(child.handle);
        throw Object.assign(failure instanceof Error ? failure : new Error("session_independent_proof_failed"), { code: "SESSION_INDEPENDENCE_UNAVAILABLE" });
      }
      close(child.thread);
      class NativeChild extends EventEmitter implements SessionHostProcess {
        readonly pid = child!.pid;
        private readonly timer = setInterval(() => {
          const code = Buffer.alloc(4);
          if (!exitCode(child!.handle, code)) return;
          if (code.readUInt32LE(0) === STILL_ACTIVE) return;
          clearInterval(this.timer); close(child!.handle); this.emit("exit");
        }, SESSION_HOST_POLL_MS);
        unref() { this.timer.unref(); }
      }
      return new NativeChild();
    },
  };
}
function quoteWindowsArg(value: string): string {
  return `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}
