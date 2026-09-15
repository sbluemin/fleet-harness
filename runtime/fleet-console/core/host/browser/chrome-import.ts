import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { launchChromium } from "./cdp.js";

/**
 * 사용자의 Google Chrome 프로필에서 쿠키를 가져온다 — 로그인 상태를 Operation 브라우저로 옮기는 길.
 *
 * 복호화는 Chrome 자신에게 맡긴다: 프로필의 Cookies DB 만 임시 user-data-dir 로 복사해 같은 Chrome 바이너리를
 * 헤드리스로 잠깐 띄우고 CDP `Storage.getCookies` 로 평문을 받는다. OS 키체인의 "Chrome Safe Storage" 키를
 * Console 이 만지지 않으므로 플랫폼별 암호 방식에 묶이지 않는다. 비밀번호·방문 기록은 격리된 브라우저 컨텍스트에
 * 넣을 CDP 경로가 없어 지원하지 않는다.
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

/** 프로필의 쿠키를 평문으로 읽는다. Chrome 이 실행 중이어도 파일 사본으로 읽으므로 방해하지 않는다. */
export async function readChromeCookies(options: { executable: string; profileId: string; userDataDir?: string; env: NodeJS.ProcessEnv; log: (message: string) => void }): Promise<ChromeCookie[]> {
  const source = options.userDataDir ?? chromeUserDataDir();
  if (!/^[A-Za-z0-9 ._-]+$/.test(options.profileId) || !fs.existsSync(path.join(source, options.profileId))) throw new Error("chrome_profile_not_found");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-browser-import-"));
  try {
    fs.copyFileSync(path.join(source, "Local State"), path.join(temp, "Local State"));
    const target = path.join(temp, options.profileId);
    fs.mkdirSync(path.join(target, "Network"), { recursive: true });
    let copied = 0;
    for (const file of COOKIE_FILES) { try { fs.copyFileSync(path.join(source, options.profileId, file), path.join(target, file)); copied += 1; } catch { /* 없는 파일 */ } }
    if (copied === 0) throw new Error("chrome_cookies_missing");
    const client = await launchChromium({ executable: options.executable, userDataDir: temp, windowSize: { width: 800, height: 600 }, env: options.env, log: options.log, extraArgs: [`--profile-directory=${options.profileId}`] });
    try {
      const result = await client.send<{ cookies: ChromeCookie[] }>("Storage.getCookies", {});
      return result.cookies.filter((cookie) => cookie.value.length > 0);
    } finally { await client.close(); await Promise.race([client.closed, new Promise((resolve) => setTimeout(resolve, 5000))]); }
  } finally {
    // Chrome 은 종료 직후에도 프로필에 파일을 몇 개 더 쓴다 — 지우기를 몇 번 되풀이한다.
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* 임시 디렉터리는 OS 가 거둔다 */ }
  }
}
