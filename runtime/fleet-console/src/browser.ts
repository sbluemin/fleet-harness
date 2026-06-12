import { spawn } from "node:child_process";
import os from "node:os";

export interface OpenBrowserDeps {
  readonly platform?: NodeJS.Platform;
  readonly spawnBrowser?: (command: string, args: readonly string[], options: { readonly detached: true; readonly stdio: "ignore" }) => void;
}

export function openBrowser(url: string, deps: OpenBrowserDeps = {}): void {
  const platform = deps.platform ?? os.platform();
  const spawnBrowser = deps.spawnBrowser ?? ((command, args, options) => { spawn(command, [...args], options).unref(); });
  if (platform === "darwin") {
    spawnBrowser("open", [url], { detached: true, stdio: "ignore" });
    return;
  }
  if (platform === "win32") {
    spawnBrowser("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" });
    return;
  }
  spawnBrowser("xdg-open", [url], { detached: true, stdio: "ignore" });
}
