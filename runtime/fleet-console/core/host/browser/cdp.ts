import { spawn, type ChildProcess } from "node:child_process";
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
  readonly source: "env" | "playwright" | "system";
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

/** 로컬 Chromium 실행 파일을 찾는다. 명시 경로 → Playwright 캐시 → 시스템 브라우저 순. 없으면 null. */
export function locateChromium(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): ChromiumCandidate | null {
  const explicit = env.FLEET_BROWSER_CHROMIUM;
  if (explicit && path.isAbsolute(explicit) && executable(explicit)) return { executable: explicit, source: "env" };
  // 시스템 Chrome 을 Playwright 의 Chrome for Testing 보다 먼저 쓴다 — 사용자가 늘 쓰는 브라우저와 같은
  // 빌드·코덱·브랜드라 사이트가 평범한 방문으로 본다.
  if (platform === "darwin") { for (const app of MAC_APPS) if (executable(app)) return { executable: app, source: "system" }; }
  else if (platform === "win32") {
    // Windows 의 env 키는 "ProgramFiles" 처럼 대소문자가 섞여 있고, 복사된 평범한 객체에서는 대소문자를 구분한다 —
    // 이름을 대소문자 무시로 찾고, 없으면 관례 경로를 쓴다.
    const envIgnoreCase = (name: string) => { const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name); return key ? env[key] : undefined; };
    const roots = [envIgnoreCase("PROGRAMFILES") ?? "C:\\Program Files", envIgnoreCase("PROGRAMFILES(X86)") ?? "C:\\Program Files (x86)", envIgnoreCase("LOCALAPPDATA")].filter((value): value is string => Boolean(value));
    for (const root of roots) for (const app of WINDOWS_APPS) { const file = path.join(root, app); if (executable(file)) return { executable: file, source: "system" }; }
  } else {
    for (const dir of (env.PATH ?? "").split(path.delimiter)) for (const bin of LINUX_BINS) { const file = path.join(dir, bin); if (executable(file)) return { executable: file, source: "system" }; }
  }
  const playwright = playwrightChromium(env, platform, home);
  if (playwright) return { executable: playwright, source: "playwright" };
  return null;
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
}

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
  const child = spawn(options.executable, args, { env: options.env, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], windowsHide: true });
  const writer = child.stdio[3] as NodeJS.WritableStream | null;
  const reader = child.stdio[4] as NodeJS.ReadableStream | null;
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
