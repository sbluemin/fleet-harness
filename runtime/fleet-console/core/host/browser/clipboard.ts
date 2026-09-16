import { execFile } from "node:child_process";
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
 * Linux 는 `xclip` 또는 `wl-copy`. 도구가 없으면 CLI 도 읽지 못했을 것이다.
 */

export interface WriteImageClipboardOptions {
  readonly platform?: NodeJS.Platform;
  readonly tempDir?: string;
  readonly run?: (file: string, args: readonly string[], input?: Buffer) => Promise<void>;
}

const defaultRun = (file: string, args: readonly string[], input?: Buffer): Promise<void> => new Promise((resolve, reject) => {
  const child = execFile(file, [...args], { timeout: 10_000, windowsHide: true }, (error) => { if (error) reject(error); else resolve(); });
  if (input) { child.stdin?.end(input); } else { child.stdin?.end(); }
});

export async function writeImageToClipboard(png: Buffer, options: WriteImageClipboardOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
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
      const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $img = [System.Drawing.Image]::FromFile(${powershellString(file)}); [System.Windows.Forms.Clipboard]::SetImage($img); $img.Dispose()`;
      await run("powershell", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script]);
      return;
    }
    try { await run("xclip", ["-selection", "clipboard", "-t", "image/png", "-i", file]); }
    catch { await run("wl-copy", ["--type", "image/png"], png); }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function powershellString(value: string): string { return `'${value.replace(/'/g, "''")}'`; }
