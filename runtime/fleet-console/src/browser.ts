import { spawn } from "node:child_process";
import os from "node:os";

export interface OpenBrowserDeps {
  readonly platform?: NodeJS.Platform;
  readonly spawnBrowser?: (command: string, args: readonly string[], options: { readonly detached: true; readonly stdio: "ignore"; readonly windowsHide: true }) => void;
}

export function openBrowser(url: string, deps: OpenBrowserDeps = {}): void {
  const platform = deps.platform ?? os.platform();
  const spawnBrowser = deps.spawnBrowser ?? ((command, args, options) => {
    const child = spawn(command, [...args], options);
    // 브라우저 실행기 미설치/헤드리스로 인한 spawn 실패는 무해하게 무시한다 — uncaught 'error' 이벤트 방지.
    child.once("error", () => {});
    child.unref();
  });
  if (platform === "darwin") {
    spawnBrowser("open", [url], { detached: true, stdio: "ignore", windowsHide: true });
    return;
  }
  if (platform === "win32") {
    spawnBrowser("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true });
    return;
  }
  spawnBrowser("xdg-open", [url], { detached: true, stdio: "ignore", windowsHide: true });
}
