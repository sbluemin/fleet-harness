import { spawn } from "node:child_process";
import os from "node:os";

/**
 * 브라우저 실행기가 실제로 떴는지에 대한 답. 실패를 삼키면 CLI가 "열었다"고 말한 뒤
 * 아무것도 뜨지 않는 화면만 남으므로, 이 결과는 호출자가 사용자에게 전할 사실이다.
 */
export interface BrowserOpenResult {
  readonly opened: boolean;
  readonly reason?: string;
}

export interface OpenBrowserDeps {
  readonly platform?: NodeJS.Platform;
  readonly spawnBrowser?: (
    command: string,
    args: readonly string[],
    options: { readonly detached: true; readonly stdio: "ignore"; readonly windowsHide: true },
  ) => void | Promise<BrowserOpenResult>;
}

// spawn 성공은 이벤트로 통보되지 않으므로 'error'가 오지 않는 짧은 구간을 성공으로 확정한다.
// ENOENT/EACCES는 이 안에서 도착한다.
const SPAWN_GRACE_MS = 250;

export function openBrowser(url: string, deps: OpenBrowserDeps = {}): Promise<BrowserOpenResult> {
  const platform = deps.platform ?? os.platform();
  const spawnBrowser = deps.spawnBrowser ?? defaultSpawnBrowser;
  const options = { detached: true, stdio: "ignore", windowsHide: true } as const;
  if (platform === "darwin") return normalize(spawnBrowser("open", [url], options));
  if (platform === "win32") return normalize(spawnBrowser("cmd", ["/c", "start", "", url], options));
  return normalize(spawnBrowser("xdg-open", [url], options));
}

async function normalize(result: void | Promise<BrowserOpenResult>): Promise<BrowserOpenResult> {
  // 결과를 돌려주지 않는 주입 스텁은 "열렸다"로 읽는다 — 실패를 주장하려면 그 사실을 실어야 한다.
  const resolved = await result;
  return resolved ?? { opened: true };
}

function defaultSpawnBrowser(
  command: string,
  args: readonly string[],
  options: { readonly detached: true; readonly stdio: "ignore"; readonly windowsHide: true },
): Promise<BrowserOpenResult> {
  return new Promise<BrowserOpenResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], options);
    } catch (error) {
      resolve({ opened: false, reason: describe(error, command) });
      return;
    }
    const timer = setTimeout(() => {
      child.unref();
      resolve({ opened: true });
    }, SPAWN_GRACE_MS);
    // 타이머가 살아 있으면 CLI 프로세스가 그만큼 늦게 끝난다 — 판정만 하고 이벤트 루프는 붙잡지 않는다.
    timer.unref?.();
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ opened: false, reason: describe(error, command) });
    });
  });
}

function describe(error: unknown, command: string): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return `${command} is not on PATH`;
  if (code === "EACCES") return `${command} is not executable`;
  return error instanceof Error ? error.message : String(error);
}
