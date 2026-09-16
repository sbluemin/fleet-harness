import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Operation Browser의 엔진 — Console 서버가 소유하는 로컬 Chromium 하나.
 *
 * 왜 CDP 파이프인가: `--remote-debugging-port`는 루프백 포트를 열어 같은 기기의 다른 프로세스가 붙을
 * 수 있고, 그 포트는 Console의 어떤 인가 게이트도 거치지 않는다. 파이프(fd 3·4)는 이 자식과 Console
 * 서버만 잇는다. 프로토콜 메시지는 NUL 로 끝나는 JSON 이고, 세션 라우팅은 `Target.attachToTarget`의
 * flatten 모드로 `sessionId` 필드에 실린다.
 */

export interface ChromiumCandidate {
  readonly executable: string;
  readonly source: "env" | "settings" | "playwright" | "system";
  /** WSL 안에서 Windows 쪽 Chrome 을 쓰는 경우 — 실행은 Windows Node.js 중계를 거친다. */
  readonly bridge?: WslBridge;
}

/** Chromium 을 못 찾은 까닭. 클라이언트가 안내 문장을 고르는 손잡이다. */
export type ChromiumMissingReason = "env_invalid" | "wsl_windows_node_missing" | "wsl_missing" | "missing";

export interface ChromiumLookup {
  readonly candidate: ChromiumCandidate | null;
  readonly reason: ChromiumMissingReason | null;
}

/**
 * WSL → Windows Chrome 중계. WSL 이 Windows 실행 파일을 띄울 때 stdin·stdout·stderr 만 건너가고 fd 3·4 는
 * 건너가지 않으므로, Windows 쪽 Node.js 가 Chrome 을 파이프로 띄우고 그 파이프를 자기 stdin·stdout 에 잇는다.
 * Console 서버는 그 중계의 stdin·stdout 을 CDP 파이프로 쓴다 — 포트는 여전히 열지 않는다.
 */
export interface WslBridge {
  /** WSL 에서 실행할 수 있는 Windows Node.js 의 경로(`/mnt/c/...`). */
  readonly node: string;
  /** Windows 쪽에서 쓸 Chrome 프로필 디렉터리(Windows 경로). Chrome 이 WSL 파일계를 UNC 로 쓰는 일을 피한다. */
  readonly userDataDir: string;
  /** Windows 쪽 `%LOCALAPPDATA%`(Windows 경로). 사용자 프로필과 임시 자리를 여기서 짚는다 — 못 읽었으면 null. */
  readonly localAppData: string | null;
  /** WSL 경로를 Windows 경로로 옮긴다(`wslpath -w`). */
  readonly toWindowsPath: (file: string) => string;
  /** Windows 경로를 WSL 경로로 되돌린다(`wslpath -u`). 못 옮기면 null. */
  readonly toLinuxPath: (file: string) => string | null;
}

const MAC_APPS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];
const LINUX_BINS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser", "microsoft-edge"];
const WINDOWS_APPS = [
  "Google\\Chrome\\Application\\chrome.exe",
  "Chromium\\Application\\chrome.exe",
  "Microsoft\\Edge\\Application\\msedge.exe",
  "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
];

function executable(file: string): boolean {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
}

function playwrightChromium(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string | null {
  const cache = env.PLAYWRIGHT_BROWSERS_PATH && path.isAbsolute(env.PLAYWRIGHT_BROWSERS_PATH)
    ? env.PLAYWRIGHT_BROWSERS_PATH
    : platform === "darwin" ? path.join(home, "Library", "Caches", "ms-playwright")
      : platform === "win32" ? path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "ms-playwright")
        : path.join(home, ".cache", "ms-playwright");
  let entries: string[];
  try { entries = fs.readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort().reverse(); } catch { return null; }
  for (const entry of entries) {
    const base = path.join(cache, entry);
    const candidates = platform === "darwin"
      ? ["chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium"]
      : platform === "win32" ? ["chrome-win64/chrome.exe", "chrome-win/chrome.exe"] : ["chrome-linux64/chrome", "chrome-linux/chrome"];
    for (const candidate of candidates) { const file = path.join(base, candidate); if (executable(file)) return file; }
  }
  return null;
}

const WSL_ROOT = "/mnt/c";

function isWsl(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (platform !== "linux") return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try { return /microsoft/i.test(fs.readFileSync("/proc/version", "utf8")); } catch { return false; }
}

/** drvfs 는 파일 권한을 다 켜서 보이므로 실행 비트는 뜻이 없다 — 있는 파일이면 된다. */
function windowsFile(file: string): boolean {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function windowsUserHomes(root: string): string[] {
  try { return fs.readdirSync(path.join(root, "Users")).filter((name) => !["Public", "Default", "Default User", "All Users"].includes(name)).map((name) => path.join(root, "Users", name)); }
  catch { return []; }
}

/** WSL 에서 보이는 Windows Chrome. Program Files → 사용자별 Local AppData 순. */
function windowsChromeFromWsl(root: string): string | null {
  const roots = [path.join(root, "Program Files"), path.join(root, "Program Files (x86)"), ...windowsUserHomes(root).map((home) => path.join(home, "AppData", "Local"))];
  for (const base of roots) for (const app of WINDOWS_APPS) { const file = path.join(base, ...app.split("\\")); if (windowsFile(file)) return file; }
  return null;
}

function windowsCommand(root: string, command: string, args: readonly string[]): string | null {
  try {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 5000, windowsHide: true });
    if (result.status !== 0) return null;
    const line = result.stdout.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean);
    return line ?? null;
  } catch { return null; }
}

function wslToWindowsPath(file: string): string {
  const mapped = windowsCommand(WSL_ROOT, "wslpath", ["-w", file]);
  if (mapped) return mapped;
  // wslpath 가 없으면 기본 마운트 규칙으로 — /mnt/c/a/b → C:\a\b, 그 밖은 UNC.
  const drive = /^\/mnt\/([a-z])(\/.*)?$/i.exec(file);
  if (drive) return `${drive[1]!.toUpperCase()}:${(drive[2] ?? "").replace(/\//g, "\\") || "\\"}`;
  return `\\\\wsl.localhost\\${process.env.WSL_DISTRO_NAME ?? "wsl"}${file.replace(/\//g, "\\")}`;
}

function wslToLinuxPath(root: string, file: string): string | null {
  const mapped = windowsCommand(root, "wslpath", ["-u", file]);
  if (mapped) return mapped;
  const drive = /^([a-z]):\\(.*)$/i.exec(file);
  return drive ? path.join(path.dirname(root), drive[1]!.toLowerCase(), drive[2]!.replace(/\\/g, "/")) : null;
}

let bridgeCache: { at: number; root: string; bridge: WslBridge | null } | null = null;
const BRIDGE_CACHE_MS = 30_000;

/**
 * Windows Node.js 를 찾아 중계를 꾸린다. Fleet Desktop 의 Windows 런타임 → PATH 의 node.exe(where.exe) →
 * 관례 설치 경로 순. 조회는 프로세스를 띄우므로 30초 동안 기억한다(상태 조회가 자주 온다).
 */
function resolveWslBridge(root: string, dataDir: string): WslBridge | null {
  const now = Date.now();
  if (bridgeCache && bridgeCache.root === root && now - bridgeCache.at < BRIDGE_CACHE_MS) return bridgeCache.bridge;
  const homes = windowsUserHomes(root);
  const candidates = [
    ...homes.map((home) => path.join(home, ".fleet", "desktop", "runtime", "node", "node.exe")),
    path.join(root, "Program Files", "nodejs", "node.exe"),
  ];
  const located = windowsCommand(root, path.join(root, "Windows", "System32", "where.exe"), ["node.exe"]);
  if (located) { const linux = wslToLinuxPath(root, located); if (linux) candidates.splice(homes.length, 0, linux); }
  const node = candidates.find(windowsFile) ?? null;
  let bridge: WslBridge | null = null;
  if (node) {
    const echoed = windowsCommand(root, path.join(root, "Windows", "System32", "cmd.exe"), ["/d", "/c", "echo %LOCALAPPDATA%"]);
    const localAppData = echoed && !echoed.includes("%") ? echoed : null;
    const stamp = crypto.createHash("sha1").update(dataDir).digest("hex").slice(0, 10);
    const userDataDir = localAppData ? `${localAppData}\\fleet-console\\browser-${stamp}` : wslToWindowsPath(path.join(dataDir, "profile"));
    bridge = { node, userDataDir, localAppData, toWindowsPath: wslToWindowsPath, toLinuxPath: (file) => wslToLinuxPath(root, file) };
  }
  bridgeCache = { at: now, root, bridge };
  return bridge;
}

export interface LookupChromiumOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly executablePath?: string;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  /** WSL 중계의 프로필 자리를 정하는 Console 데이터 디렉터리. */
  readonly dataDir?: string;
  /** Windows 드라이브의 WSL 마운트 지점. 시험에서만 바꾼다. */
  readonly windowsRoot?: string;
}

/**
 * 로컬 Chromium 실행 파일을 찾고, 없으면 그 까닭을 함께 돌려준다. 명시 경로 → 시스템 브라우저 → Playwright 캐시
 * → (WSL) Windows 의 브라우저 순. 명시 경로가 틀리면 다른 브라우저로 조용히 넘어가지 않는다 — 설정이 틀렸다는
 * 사실이 안내 문장이 된다.
 */
export function lookupChromium(options: LookupChromiumOptions = {}): ChromiumLookup {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const explicit = env.FLEET_BROWSER_CHROMIUM || options.executablePath;
  if (explicit) {
    const source = env.FLEET_BROWSER_CHROMIUM ? "env" : "settings";
    if (!path.isAbsolute(explicit) || !executable(explicit)) return { candidate: null, reason: "env_invalid" };
    if (isWsl(env, platform) && /\.exe$/i.test(explicit)) {
      const bridge = resolveWslBridge(options.windowsRoot ?? WSL_ROOT, options.dataDir ?? path.join(home, ".fleet", "console"));
      return bridge ? { candidate: { executable: explicit, source, bridge }, reason: null } : { candidate: null, reason: "wsl_windows_node_missing" };
    }
    return { candidate: { executable: explicit, source }, reason: null };
  }
  // 시스템 Chrome 을 Playwright 의 Chrome for Testing 보다 먼저 쓴다 — 사용자가 늘 쓰는 브라우저와 같은
  // 빌드·코덱·브랜드라 사이트가 평범한 방문으로 본다.
  if (platform === "darwin") { for (const app of MAC_APPS) if (executable(app)) return { candidate: { executable: app, source: "system" }, reason: null }; }
  else if (platform === "win32") {
    // Windows 의 env 키는 "ProgramFiles" 처럼 대소문자가 섞여 있고, 복사된 평범한 객체에서는 대소문자를 구분한다 —
    // 이름을 대소문자 무시로 찾고, 없으면 관례 경로를 쓴다.
    const envIgnoreCase = (name: string) => { const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name); return key ? env[key] : undefined; };
    const roots = [envIgnoreCase("PROGRAMFILES") ?? "C:\\Program Files", envIgnoreCase("PROGRAMFILES(X86)") ?? "C:\\Program Files (x86)", envIgnoreCase("LOCALAPPDATA")].filter((value): value is string => Boolean(value));
    for (const root of roots) for (const app of WINDOWS_APPS) { const file = path.join(root, app); if (executable(file)) return { candidate: { executable: file, source: "system" }, reason: null }; }
  } else {
    for (const dir of (env.PATH ?? "").split(path.delimiter)) for (const bin of LINUX_BINS) { const file = path.join(dir, bin); if (executable(file)) return { candidate: { executable: file, source: "system" }, reason: null }; }
  }
  const playwright = playwrightChromium(env, platform, home);
  if (playwright) return { candidate: { executable: playwright, source: "playwright" }, reason: null };
  if (isWsl(env, platform)) {
    const root = options.windowsRoot ?? WSL_ROOT;
    const chrome = windowsChromeFromWsl(root);
    if (!chrome) return { candidate: null, reason: "wsl_missing" };
    const bridge = resolveWslBridge(root, options.dataDir ?? path.join(home, ".fleet", "console"));
    if (!bridge) return { candidate: null, reason: "wsl_windows_node_missing" };
    return { candidate: { executable: chrome, source: "system", bridge }, reason: null };
  }
  return { candidate: null, reason: "missing" };
}

/** 로컬 Chromium 실행 파일을 찾는다. 없으면 null — 까닭까지 필요하면 `lookupChromium`. */
export function locateChromium(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): ChromiumCandidate | null {
  return lookupChromium({ env, platform, home }).candidate;
}

export interface CdpEvent { readonly method: string; readonly params: Record<string, unknown>; readonly sessionId?: string }
export type CdpListener = (event: CdpEvent) => void;

export class CdpError extends Error {
  constructor(readonly method: string, readonly code: number, message: string) { super(`${method}: ${message}`); this.name = "CdpError"; }
}

export interface CdpClient {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  on(listener: CdpListener): () => void;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; method: string }

/** 파이프 위의 CDP 클라이언트. 응답은 id로, 이벤트는 등록된 리스너 전체로 흐른다. */
class PipeCdpClient implements CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<CdpListener>();
  private buffer = "";
  private closedFlag = false;
  private resolveClosed!: () => void;
  readonly closed: Promise<void>;
  constructor(private readonly child: ChildProcess, private readonly writer: NodeJS.WritableStream, reader: NodeJS.ReadableStream, private readonly log: (message: string) => void) {
    this.closed = new Promise<void>((resolve) => { this.resolveClosed = resolve; });
    reader.setEncoding("utf8");
    reader.on("data", (chunk: string) => this.consume(chunk));
    reader.on("end", () => this.teardown("pipe closed"));
    child.on("exit", (code, signal) => this.teardown(`chromium exited (${code ?? signal ?? "unknown"})`));
    child.on("error", (error) => this.teardown(`chromium error: ${error.message}`));
  }
  private consume(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\0")) !== -1) {
      const raw = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      let message: { id?: number; result?: unknown; error?: { code: number; message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      try { message = JSON.parse(raw); } catch { this.log("cdp: unparsable message dropped"); continue; }
      if (typeof message.id === "number") {
        const entry = this.pending.get(message.id);
        if (!entry) continue;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new CdpError(entry.method, message.error.code, message.error.message));
        else entry.resolve(message.result ?? {});
      } else if (typeof message.method === "string") {
        const event: CdpEvent = { method: message.method, params: message.params ?? {}, ...(message.sessionId ? { sessionId: message.sessionId } : {}) };
        for (const listener of this.listeners) { try { listener(event); } catch (error) { this.log(`cdp listener failed: ${error instanceof Error ? error.message : "unknown"}`); } }
      }
    }
  }
  private teardown(reason: string): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    for (const [, entry] of this.pending) entry.reject(new Error(`browser_engine_closed: ${reason}`));
    this.pending.clear();
    this.listeners.clear();
    this.resolveClosed();
  }
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closedFlag) return Promise.reject(new Error("browser_engine_closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, method });
      const payload = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0";
      this.writer.write(payload, (error) => { if (error) { this.pending.delete(id); reject(error); } });
    });
  }
  on(listener: CdpListener): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async close(): Promise<void> {
    if (this.closedFlag) return;
    try { await Promise.race([this.send("Browser.close"), new Promise((resolve) => setTimeout(resolve, 1500))]); } catch { /* 이미 닫혔다 */ }
    if (this.child.exitCode === null && !this.child.killed) this.child.kill("SIGTERM");
    const exited = await Promise.race([this.closed.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000))]);
    if (!exited && this.child.exitCode === null) this.child.kill("SIGKILL");
    this.teardown("closed by console");
  }
}

export interface LaunchChromiumOptions {
  readonly executable: string;
  readonly userDataDir: string;
  readonly windowSize: { readonly width: number; readonly height: number };
  /** 창 표면의 물리 배율. 스크린캐스트는 창 표면 크기로 찍히므로 레티나 패널을 위해 2로 띄운다. */
  readonly deviceScaleFactor?: number;
  readonly env: NodeJS.ProcessEnv;
  readonly log: (message: string) => void;
  /** 추가 인자 — 프로필 디렉터리 지정 같은 특수 기동에만 쓴다. */
  readonly extraArgs?: readonly string[];
  /** WSL → Windows Chrome 중계. 있으면 Chrome 을 Windows Node.js 가 띄우고 CDP 는 그 stdin·stdout 을 탄다. */
  readonly bridge?: WslBridge;
}

/**
 * Windows 쪽 Node.js 가 실행하는 중계 — Chrome 을 fd 3·4 파이프로 띄우고 자기 fd 0 → fd 3, fd 4 → fd 1 로 잇는다.
 * 파일로 싣지 않고 `-e` 로 넘긴다: 호스트 번들 안에 따로 실어 나를 것이 없다.
 *
 * `process.stdin`·`process.stdout` 을 건드리지 않는다: WSL 이 건네준 파이프 핸들에 Node 가 소켓을 열려 하면
 * `open EISDIR` 로 중계가 부팅 중에 죽는다. 같은 핸들도 fs 로 읽고 쓰면 멀쩡하다.
 */
export const WSL_BRIDGE_RELAY = [
  'const {spawn}=require("node:child_process");const fs=require("node:fs");',
  'const [exe,...args]=process.argv.slice(1);',
  'const c=spawn(exe,args,{stdio:["ignore","ignore","inherit","pipe","pipe"],windowsHide:true});',
  // writeSync 는 조각만 쓰고 돌아올 수 있다 — 다 나갈 때까지 민다. CDP 메시지가 잘리면 응답이 영영 오지 않는다.
  'const out=(b)=>{let o=0;while(o<b.length)o+=fs.writeSync(1,b,o,b.length-o);};',
  'const inp=fs.createReadStream(null,{fd:0});',
  'inp.on("data",(d)=>c.stdio[3].write(d));',
  'c.stdio[4].on("data",(d)=>{try{out(d);}catch{}});',
  'c.on("exit",(code)=>process.exit(code==null?1:code));c.on("error",()=>process.exit(1));',
  'const bye=()=>{try{c.kill();}catch{}};inp.on("end",bye);inp.on("close",bye);inp.on("error",bye);',
].join("");

/** 헤드리스 Chromium 하나를 띄우고 파이프 CDP 클라이언트를 돌려준다. 포트는 열지 않는다. */
export async function launchChromium(options: LaunchChromiumOptions): Promise<CdpClient> {
  fs.mkdirSync(options.userDataDir, { recursive: true });
  const args = [
    "--remote-debugging-pipe",
    "--headless=new",
    // 사람이 쓰는 창이다 — 헤드리스가 켜는 navigator.webdriver 자동화 표시는 끈다.
    "--disable-blink-features=AutomationControlled",
    `--user-data-dir=${options.userDataDir}`,
    `--window-size=${options.windowSize.width},${options.windowSize.height}`,
    ...(options.deviceScaleFactor && options.deviceScaleFactor !== 1 ? [`--force-device-scale-factor=${options.deviceScaleFactor}`] : []),
    "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-extensions",
    "--disable-background-networking", "--disable-component-update", "--disable-default-apps",
    "--disable-features=Translate,MediaRouter,OptimizationHints", "--metrics-recording-only", "--mute-audio",
    "--force-color-profile=srgb", "--hide-crash-restore-bubble",
    ...(options.extraArgs ?? []),
    "about:blank",
  ];
  let child: ChildProcess;
  let writer: NodeJS.WritableStream | null;
  let reader: NodeJS.ReadableStream | null;
  if (options.bridge) {
    const bridge = options.bridge;
    const relayArgs = args.map((arg) => arg.startsWith("--user-data-dir=") ? `--user-data-dir=${bridge.userDataDir}` : arg);
    child = spawn(bridge.node, ["-e", WSL_BRIDGE_RELAY, "--", bridge.toWindowsPath(options.executable), ...relayArgs], { env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    writer = child.stdin;
    reader = child.stdout;
  } else {
    child = spawn(options.executable, args, { env: options.env, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], windowsHide: true });
    writer = child.stdio[3] as NodeJS.WritableStream | null;
    reader = child.stdio[4] as NodeJS.ReadableStream | null;
  }
  if (!writer || !reader) { child.kill("SIGKILL"); throw new Error("browser_engine_pipe_unavailable"); }
  (child.stderr as NodeJS.ReadableStream | null)?.on("data", () => undefined);
  const client = new PipeCdpClient(child, writer, reader, options.log);
  const ready = await Promise.race([
    client.send("Browser.getVersion").then(() => true, () => false),
    client.closed.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 15_000)),
  ]);
  if (!ready) { await client.close(); throw new Error("browser_engine_start_failed"); }
  return client;
}
