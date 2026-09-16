import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { launchChromium, type WslBridge } from "./cdp.js";

/**
 * 사용자의 Google Chrome 프로필에서 쿠키를 가져온다 — 로그인 상태를 Operation 브라우저로 옮기는 길.
 *
 * 복호화는 Chrome 자신에게 맡긴다: 프로필의 Cookies DB 만 임시 user-data-dir 로 복사해 같은 Chrome 바이너리를
 * 헤드리스로 잠깐 띄우고 CDP `Storage.getCookies` 로 평문을 받는다. OS 키체인의 "Chrome Safe Storage" 키를
 * Console 이 만지지 않으므로 플랫폼별 암호 방식에 묶이지 않는다. 비밀번호·방문 기록은 격리된 브라우저 컨텍스트에
 * 넣을 CDP 경로가 없어 지원하지 않는다.
 *
 * WSL 에서 Windows Chrome 을 쓸 때도 같은 방법을 쓰되 무대를 Windows 쪽으로 옮긴다. Local State 의 쿠키 키는
 * Windows 사용자에게 DPAPI 로 묶여 있고(Chrome 127+ 는 app-bound 키가 하나 더 있다), Chrome 은 WSL 경로를
 * 자기 드라이브의 경로로 읽는다 — WSL 임시 디렉터리에 풀어 놓으면 Chrome 은 엉뚱한 자리에서 빈 프로필을 새로
 * 만들고 키를 얻지 못한다. 그래서 사본을 Windows 임시 디렉터리에 두고 중계로 그쪽 chrome.exe 를 띄운다.
 */

export interface ChromeProfile { readonly id: string; readonly name: string; readonly account: string | null }

export interface ChromeCookie { readonly name: string; readonly value: string; readonly domain: string; readonly path: string; readonly expires: number; readonly httpOnly: boolean; readonly secure: boolean; readonly sameSite?: "Strict" | "Lax" | "None"; readonly priority?: "Low" | "Medium" | "High"; readonly sourceScheme?: "Unset" | "NonSecure" | "Secure"; readonly sourcePort?: number; readonly partitionKey?: unknown }

export function chromeUserDataDir(platform: NodeJS.Platform = process.platform, home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Google", "Chrome");
  if (platform === "win32") return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Google", "Chrome", "User Data");
  return path.join(home, ".config", "google-chrome");
}

export function isGoogleChrome(executable: string | null): boolean {
  return !!executable && /google chrome|chrome\.exe$|\/google-chrome(-stable)?$/i.test(executable);
}

/**
 * WSL 에서 보는 Windows Chrome 의 User Data 디렉터리. 중계가 읽어 온 Windows `%LOCALAPPDATA%` 를 WSL 경로로
 * 되돌려 찾고, 그것이 없으면 사용자별 설치의 실행 파일(`…\Chrome\Application\chrome.exe`)에서 형제 디렉터리로
 * 짚는다 — Chromium 계열을 엔진으로 쓸 때도 그 브라우저 자신의 프로필을 가리키게 된다.
 */
export function bridgedChromeUserDataDir(executable: string, bridge: WslBridge): string | null {
  const mapped = bridge.localAppData ? bridge.toLinuxPath(`${bridge.localAppData}\\Google\\Chrome\\User Data`) : null;
  if (mapped && fs.existsSync(mapped)) return mapped;
  const application = path.dirname(executable);
  const sibling = path.join(path.dirname(application), "User Data");
  if (/^application$/i.test(path.basename(application)) && fs.existsSync(sibling)) return sibling;
  return mapped;
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

const COOKIE_FILES = ["Cookies", "Cookies-journal", path.join("Network", "Cookies"), path.join("Network", "Cookies-journal")];

/**
 * 사본을 풀어 놓을 임시 디렉터리. 중계가 있으면 Windows 임시 디렉터리에 만든다 — `directory` 는 그 자리를 WSL 에서
 * 가리키는 경로(복사는 여기로 한다), `userDataDir` 은 Chrome 에 건넬 같은 자리의 Windows 경로다.
 */
function stageDirectory(bridge?: WslBridge): { directory: string; userDataDir: string } {
  if (!bridge) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-browser-import-")); return { directory, userDataDir: directory }; }
  const windowsTemp = bridge.localAppData ? `${bridge.localAppData}\\Temp` : null;
  const root = windowsTemp ? bridge.toLinuxPath(windowsTemp) : null;
  if (!windowsTemp || !root) throw new Error("chrome_bridge_unavailable");
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, "fleet-browser-import-"));
  return { directory, userDataDir: `${windowsTemp}\\${path.basename(directory)}` };
}

/** 프로필의 쿠키를 평문으로 읽는다. Chrome 이 실행 중이어도 파일 사본으로 읽으므로 방해하지 않는다. */
export async function readChromeCookies(options: { executable: string; profileId: string; userDataDir?: string; env: NodeJS.ProcessEnv; log: (message: string) => void; bridge?: WslBridge }): Promise<ChromeCookie[]> {
  const source = options.userDataDir ?? chromeUserDataDir();
  if (!/^[A-Za-z0-9 ._-]+$/.test(options.profileId) || !fs.existsSync(path.join(source, options.profileId))) throw new Error("chrome_profile_not_found");
  const stage = stageDirectory(options.bridge);
  const temp = stage.directory;
  try {
    fs.copyFileSync(path.join(source, "Local State"), path.join(temp, "Local State"));
    const target = path.join(temp, options.profileId);
    fs.mkdirSync(path.join(target, "Network"), { recursive: true });
    let copied = 0;
    for (const file of COOKIE_FILES) { try { fs.copyFileSync(path.join(source, options.profileId, file), path.join(target, file)); copied += 1; } catch { /* 없는 파일 */ } }
    if (copied === 0) throw new Error("chrome_cookies_missing");
    const client = await launchChromium({ executable: options.executable, userDataDir: temp, windowSize: { width: 800, height: 600 }, env: options.env, log: options.log, extraArgs: [`--profile-directory=${options.profileId}`], ...(options.bridge ? { bridge: { ...options.bridge, userDataDir: stage.userDataDir } } : {}) });
    try {
      const result = await client.send<{ cookies: ChromeCookie[] }>("Storage.getCookies", {});
      return result.cookies.filter((cookie) => cookie.value.length > 0);
    } finally { await client.close(); await Promise.race([client.closed, new Promise((resolve) => setTimeout(resolve, 5000))]); }
  } finally {
    // Chrome 은 종료 직후에도 프로필에 파일을 몇 개 더 쓴다 — 지우기를 몇 번 되풀이한다.
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* 임시 디렉터리는 OS 가 거둔다 */ }
  }
}
