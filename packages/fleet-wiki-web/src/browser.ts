import { spawn } from "node:child_process";
import os from "node:os";

interface BrowserCommand {
  command: string;
  args: string[];
}

export async function openBrowser(url: string): Promise<void> {
  if (process.env.FLEET_WIKI_NO_BROWSER === "1") return;

  const command = browserCommand(url);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function browserCommand(url: string): BrowserCommand {
  const platform = os.platform();
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }
  return { command: "xdg-open", args: [url] };
}
