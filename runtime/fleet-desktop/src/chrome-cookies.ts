import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 이 기계의 Google Chrome 프로필에서 쿠키를 가져온다 — 로그인 상태를 Operation 브라우저 뷰로 옮기는 길.
 *
 * 브라우저 뷰는 창을 든 Desktop 안에 살고, 사람이 늘 쓰는 Chrome 도 같은 기계에 있다. 그래서 가져오기는 콘솔이
 * 아니라 셸의 일이다 — 원격 콘솔에 건너가 있어도 쿠키는 이 기계의 Chrome 에서 나와 이 창의 뷰로 들어간다.
 *
 * 복호화는 Chrome 자신에게 맡긴다: 프로필의 Cookies DB 만 임시 user-data-dir 로 복사해 같은 Chrome 바이너리를
 * 헤드리스로 잠깐 띄우고 CDP `Storage.getCookies` 로 평문을 받는다. OS 키체인의 "Chrome Safe Storage" 키를
 * Desktop 이 만지지 않으므로 플랫폼별 암호 방식에 묶이지 않는다. 비밀번호·방문 기록은 격리된 세션에 넣을 길이
 * 없어 지원하지 않는다. CDP 는 파이프(fd 3·4)로만 잇는다 — 포트를 열면 같은 기기의 다른 프로세스가 붙을 수 있다.
 */

export interface ChromeProfile { readonly id: string; readonly name: string; readonly account: string | null }
export interface ChromeImportSources { readonly available: boolean; readonly reason: "chrome_required" | "no_profiles" | null; readonly profiles: readonly ChromeProfile[] }

export interface ChromeCookie {
  readonly name: string; readonly value: string; readonly domain: string; readonly path: string; readonly expires: number;
  readonly httpOnly: boolean; readonly secure: boolean; readonly sameSite?: "Strict" | "Lax" | "None";
}

/** Electron `session.cookies.set` 이 받는 모양 — 여기서 만들면 셸이 Electron 없이도 변환을 시험할 수 있다. */
export interface ElectronCookie {
  readonly url: string; readonly name: string; readonly value: string; readonly domain?: string; readonly path: string;
  readonly secure: boolean; readonly httpOnly: boolean; readonly expirationDate?: number; readonly sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
}

interface Platform { readonly platform: NodeJS.Platform; readonly env: NodeJS.ProcessEnv; readonly home: string }
const here = (): Platform => ({ platform: process.platform, env: process.env, home: os.homedir() });

const executable = (file: string): boolean => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } };

/** Google Chrome 만 찾는다 — 읽는 것이 그 Chrome 의 프로필이므로 다른 Chromium 계열은 뜻이 없다. */
export function locateGoogleChrome(input: Partial<Platform> = {}): string | null {
  const { platform, env, home } = { ...here(), ...input };
  if (platform === "darwin") {
    for (const app of ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", path.join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome")]) if (executable(app)) return app;
    return null;
  }
  if (platform === "win32") {
    const envIgnoreCase = (name: string) => { const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name); return key ? env[key] : undefined; };
    const roots = [envIgnoreCase("PROGRAMFILES") ?? "C:\\Program Files", envIgnoreCase("PROGRAMFILES(X86)") ?? "C:\\Program Files (x86)", envIgnoreCase("LOCALAPPDATA")].filter((value): value is string => Boolean(value));
    for (const root of roots) { const file = path.join(root, "Google", "Chrome", "Application", "chrome.exe"); if (executable(file)) return file; }
    return null;
  }
  for (const dir of (env.PATH ?? "").split(path.delimiter)) for (const bin of ["google-chrome", "google-chrome-stable"]) { const file = path.join(dir, bin); if (executable(file)) return file; }
  return executable("/opt/google/chrome/chrome") ? "/opt/google/chrome/chrome" : null;
}

export function chromeUserDataDir(input: Partial<Platform> = {}): string {
  const { platform, env, home } = { ...here(), ...input };
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Google", "Chrome");
  if (platform === "win32") return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Google", "Chrome", "User Data");
  return path.join(home, ".config", "google-chrome");
}

export function listChromeProfiles(userDataDir: string = chromeUserDataDir()): ChromeProfile[] {
  let raw: string;
  try { raw = fs.readFileSync(path.join(userDataDir, "Local State"), "utf8"); } catch { return []; }
  try {
    const parsed = JSON.parse(raw) as { profile?: { info_cache?: Record<string, { name?: string; user_name?: string; gaia_name?: string }> } };
    const cache = parsed.profile?.info_cache ?? {};
    return Object.entries(cache)
      .filter(([dir]) => fs.existsSync(path.join(userDataDir, dir)))
      .map(([dir, info]) => ({ id: dir, name: info.gaia_name || info.name || dir, account: info.user_name || null }))
      .sort((a, b) => (a.id === "Default" ? -1 : b.id === "Default" ? 1 : a.name.localeCompare(b.name)));
  } catch { return []; }
}

/** 가져올 수 있는 원본 — 이 기계에 Google Chrome 이 있을 때만, 그 Chrome 의 프로필들. */
export function chromeImportSources(input: Partial<Platform> = {}): ChromeImportSources {
  if (!locateGoogleChrome(input)) return { available: false, reason: "chrome_required", profiles: [] };
  const profiles = listChromeProfiles(chromeUserDataDir(input));
  return { available: profiles.length > 0, reason: profiles.length > 0 ? null : "no_profiles", profiles };
}

const COOKIE_FILES = ["Cookies", "Cookies-journal", path.join("Network", "Cookies"), path.join("Network", "Cookies-journal")];
const PROFILE_ID = /^[A-Za-z0-9 ._-]+$/;

/** CDP 쿠키 → Electron 쿠키. 앞에 점이 붙은 도메인 쿠키는 그대로, 호스트 전용 쿠키는 URL 로만 묶는다. */
export function toElectronCookie(cookie: ChromeCookie): ElectronCookie {
  const host = cookie.domain.replace(/^\./u, "");
  const sameSite = cookie.sameSite === "Strict" ? "strict" : cookie.sameSite === "Lax" ? "lax" : cookie.sameSite === "None" ? "no_restriction" : "unspecified";
  return {
    url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path.startsWith("/") ? cookie.path : `/${cookie.path}`}`,
    name: cookie.name, value: cookie.value, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite,
    ...(cookie.domain.startsWith(".") ? { domain: cookie.domain } : {}),
    ...(cookie.expires > 0 ? { expirationDate: cookie.expires } : {}),
  };
}

export interface ReadChromeCookiesOptions {
  readonly profileId: string;
  readonly executable?: string;
  readonly userDataDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly tempRoot?: string;
  readonly log?: (message: string) => void;
}

/** 프로필의 쿠키를 평문으로 읽는다. Chrome 이 실행 중이어도 파일 사본으로 읽으므로 방해하지 않는다. */
export async function readChromeCookies(options: ReadChromeCookiesOptions): Promise<ChromeCookie[]> {
  const chrome = options.executable ?? locateGoogleChrome();
  if (!chrome) throw new Error("chrome_required");
  const source = options.userDataDir ?? chromeUserDataDir();
  if (!PROFILE_ID.test(options.profileId) || !fs.existsSync(path.join(source, options.profileId))) throw new Error("chrome_profile_not_found");
  const temp = fs.mkdtempSync(path.join(options.tempRoot ?? os.tmpdir(), "fleet-browser-import-"));
  const log = options.log ?? (() => {});
  try {
    fs.copyFileSync(path.join(source, "Local State"), path.join(temp, "Local State"));
    const target = path.join(temp, options.profileId);
    fs.mkdirSync(path.join(target, "Network"), { recursive: true });
    let copied = 0;
    for (const file of COOKIE_FILES) { try { fs.copyFileSync(path.join(source, options.profileId, file), path.join(target, file)); copied += 1; } catch { /* 없는 파일 */ } }
    if (copied === 0) throw new Error("chrome_cookies_missing");
    const client = await launchHeadlessChrome({ executable: chrome, userDataDir: temp, profileId: options.profileId, env: options.env ?? process.env, log });
    try {
      const result = await client.send<{ cookies: ChromeCookie[] }>("Storage.getCookies", {});
      return result.cookies.filter((cookie) => cookie.value.length > 0);
    } finally { await client.close(); }
  } finally {
    // Chrome 은 종료 직후에도 프로필에 파일을 몇 개 더 쓴다 — 지우기를 몇 번 되풀이한다.
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* 임시 디렉터리는 OS 가 거둔다 */ }
  }
}

// ---------- 파이프 CDP (가져오기에 필요한 만큼만) ----------

interface PipeClient { send<T>(method: string, params?: Record<string, unknown>): Promise<T>; close(): Promise<void> }

async function launchHeadlessChrome(options: { executable: string; userDataDir: string; profileId: string; env: NodeJS.ProcessEnv; log: (message: string) => void }): Promise<PipeClient> {
  const args = [
    "--remote-debugging-pipe", "--headless=new", `--user-data-dir=${options.userDataDir}`, `--profile-directory=${options.profileId}`,
    "--window-size=800,600", "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-extensions",
    "--disable-background-networking", "--disable-component-update", "--disable-default-apps",
    "--disable-features=Translate,MediaRouter,OptimizationHints", "--metrics-recording-only", "--mute-audio", "--hide-crash-restore-bubble",
    "about:blank",
  ];
  const child = spawn(options.executable, args, { env: options.env, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], windowsHide: true });
  const writer = child.stdio[3] as NodeJS.WritableStream | null;
  const reader = child.stdio[4] as NodeJS.ReadableStream | null;
  if (!writer || !reader) { child.kill("SIGKILL"); throw new Error("chrome_import_failed"); }
  (child.stderr as NodeJS.ReadableStream | null)?.on("data", () => undefined);
  const client = createPipeClient(child, writer, reader, options.log);
  const ready = await Promise.race([
    client.send("Browser.getVersion").then(() => true, () => false),
    client.exited.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 15_000)),
  ]);
  if (!ready) { await client.close(); throw new Error("chrome_import_failed"); }
  return client;
}

function createPipeClient(child: ChildProcess, writer: NodeJS.WritableStream, reader: NodeJS.ReadableStream, log: (message: string) => void): PipeClient & { readonly exited: Promise<void> } {
  let nextId = 1;
  let buffer = "";
  let done = false;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; method: string }>();
  let resolveExited!: () => void;
  const exited = new Promise<void>((resolve) => { resolveExited = resolve; });
  const teardown = (reason: string): void => {
    if (done) return;
    done = true;
    for (const entry of pending.values()) entry.reject(new Error(`chrome_import_failed: ${reason}`));
    pending.clear();
    resolveExited();
  };
  reader.setEncoding("utf8");
  reader.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\0")) !== -1) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let message: { id?: number; result?: unknown; error?: { message: string } };
      try { message = JSON.parse(raw); } catch { log("chrome import: unparsable CDP message dropped"); continue; }
      if (typeof message.id !== "number") continue;
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(`chrome_import_failed: ${entry.method}: ${message.error.message}`)); else entry.resolve(message.result ?? {});
    }
  });
  reader.on("end", () => teardown("pipe closed"));
  child.on("exit", (code, signal) => teardown(`chrome exited (${code ?? signal ?? "unknown"})`));
  child.on("error", (error) => teardown(error.message));
  return {
    exited,
    send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      if (done) return Promise.reject(new Error("chrome_import_failed: closed"));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, method });
        writer.write(`${JSON.stringify({ id, method, params })}\0`, (error) => { if (error) { pending.delete(id); reject(error); } });
      });
    },
    async close(): Promise<void> {
      if (done) return;
      try { await Promise.race([this.send("Browser.close"), new Promise((resolve) => setTimeout(resolve, 1500))]); } catch { /* 이미 닫혔다 */ }
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
      const gone = await Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000))]);
      if (!gone && child.exitCode === null) child.kill("SIGKILL");
      teardown("closed by desktop");
    },
  };
}
