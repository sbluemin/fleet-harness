import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * 이 기계의 OS 클립보드에 PNG 한 장을 올린다 — Operation Browser 의 스크린샷을 터미널 CLI 에 붙여넣는 길.
 *
 * 왜 서버가 올리는가: 터미널 CLI 는 자기가 도는 기계의 클립보드를 읽는다. 패널(렌더러)이 올린 클립보드는 창을 든
 * 기계의 것이라 원격 콘솔이면 엉뚱한 기계이고, 같은 기계여도 Chromium 이 붙여넣기 키보다 늦게 실제 데이터를
 * 실어 CLI 가 빈 클립보드를 읽었다. 여기서 올리고 나서야 Ctrl+V 를 누르므로 순서가 보장된다.
 *
 * 각 플랫폼에서 CLI 가 읽는 것과 같은 도구로 쓴다: macOS 는 `osascript`, Windows 는 PowerShell 의 Forms 클립보드,
 * Linux 는 `xclip` 또는 `wl-copy`. WSL 은 Linux 가 아니라 Windows 다 — 클립보드는 Windows 의 것이고 CLI 도
 * Windows 상호운용의 `powershell.exe` 로 읽으므로, 사본을 WSL 경로 그대로 두고 `wslpath -w` 로 옮긴 UNC 경로
 * (`\\wsl.localhost\<distro>\…`)를 PowerShell 에 건넨다. 도구가 없으면 CLI 도 읽지 못했을 것이다.
 */

export interface WriteImageClipboardOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly tempDir?: string;
  /** 명령을 실행하고 표준 출력을 돌려준다. 시험에서 바꾼다. */
  readonly run?: (file: string, args: readonly string[], input?: Buffer) => Promise<string>;
}

const COMMAND_TIMEOUT_MS = 20_000;
const WSL_POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

const defaultRun = (file: string, args: readonly string[], input?: Buffer): Promise<string> => new Promise((resolve, reject) => {
  const child = execFile(file, [...args], { timeout: COMMAND_TIMEOUT_MS, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${path.basename(file)} failed: ${(stderr || error.message).trim().slice(0, 300)}`)); else resolve(String(stdout));
  });
  if (input) child.stdin?.end(input); else child.stdin?.end();
});

export function isWsl(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, readProcVersion: () => string = () => fsSync.readFileSync("/proc/version", "utf8")): boolean {
  if (platform !== "linux") return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try { return /microsoft/i.test(readProcVersion()); } catch { return false; }
}

/** WSL 에서 보이는 Windows PowerShell — PATH 의 `powershell.exe`(상호운용) 가 먼저, 없으면 관례 경로. CLI 와 같은 순서다. */
export function wslPowershell(env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = (file) => { try { return fsSync.statSync(file).isFile(); } catch { return false; } }): string {
  for (const dir of (env.PATH ?? "").split(":")) { if (dir && exists(path.join(dir, "powershell.exe"))) return path.join(dir, "powershell.exe"); }
  return WSL_POWERSHELL;
}

/** PowerShell 이 클립보드에 PNG 를 올리는 스크립트. 파일은 바이트로 읽어 스트림에서 연다 — UNC 경로도, 파일 잠금도 걱정이 없다. */
export function powershellSetImageScript(windowsPath: string): string {
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    `$bytes = [System.IO.File]::ReadAllBytes(${powershellString(windowsPath)})`,
    "$stream = New-Object System.IO.MemoryStream(,$bytes)",
    "$img = [System.Drawing.Image]::FromStream($stream)",
    "[System.Windows.Forms.Clipboard]::SetImage($img)",
    "$img.Dispose(); $stream.Dispose()",
  ].join("; ");
}

export async function writeImageToClipboard(png: Buffer, options: WriteImageClipboardOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.run ?? defaultRun;
  const tempDir = await fs.mkdtemp(path.join(options.tempDir ?? os.tmpdir(), "fleet-browser-clip-"));
  const file = path.join(tempDir, "screenshot.png");
  try {
    await fs.writeFile(file, png);
    if (platform === "darwin") {
      await run("/usr/bin/osascript", ["-e", `set the clipboard to (read (POSIX file ${JSON.stringify(file)}) as «class PNGf»)`]);
      return;
    }
    if (platform === "win32") {
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Sta", "-Command", powershellSetImageScript(file)]);
      return;
    }
    // WSL2 커널 위의 Linux 컨테이너도 /proc/version 에 microsoft 가 찍히지만 wslpath 도 상호운용도 없다 — Windows 길이
    // 막히면 그 컨테이너가 갖춘 Linux 도구로 내려간다. 진짜 WSL 에서 PowerShell 이 실패한 까닭은 함께 남긴다.
    let windowsFailure: string | null = null;
    if (isWsl(platform, env)) {
      try {
        const windowsPath = (await run("wslpath", ["-w", file])).trim();
        if (!windowsPath) throw new Error("wslpath returned no Windows path");
        await run(wslPowershell(env), ["-NoProfile", "-NonInteractive", "-Sta", "-Command", powershellSetImageScript(windowsPath)]);
        return;
      } catch (error) { windowsFailure = error instanceof Error ? error.message : "wsl clipboard failed"; }
    }
    try { await run("xclip", ["-selection", "clipboard", "-t", "image/png", "-i", file]); }
    catch (xclipError) {
      try { await run("wl-copy", ["--type", "image/png"], png); }
      catch (wlError) {
        const linux = `${xclipError instanceof Error ? xclipError.message : "xclip failed"}; ${wlError instanceof Error ? wlError.message : "wl-copy failed"}`;
        throw new Error(windowsFailure ? `${windowsFailure}; ${linux}` : linux);
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** PowerShell 홑따옴표 문자열. 홑따옴표는 두 번 써서 이스케이프한다. 굽은 따옴표(U+2018..201F)도 PowerShell 은 따옴표로 읽으므로 거른다. */
function powershellString(value: string): string {
  if (/[‘-‟]/u.test(value)) throw new Error("path contains a PowerShell quote-variant character");
  return `'${value.replace(/'/g, "''")}'`;
}
