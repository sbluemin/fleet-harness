import * as fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

import { MISSION_CONTROL_THEME } from "../renderer.js";
import { centerText } from "../welcome.js";
import { createInputModal } from "./input-modal.js";
import { isEnter, renderBreadcrumbs, type MenuPanel, type PanelStack } from "./panel-stack.js";

export interface WikiProcessController {
  readonly getPort: () => number;
  readonly getStatus: () => WikiServerStatus;
  readonly setPort: (port: number) => void;
  readonly start: () => void;
  readonly stop: () => void;
}

export interface WikiPanelDeps {
  readonly cwd: string;
  readonly onRenderRequest: () => void;
  readonly stack: PanelStack;
  readonly wiki?: WikiProcessController;
}

export type WikiServerStatus =
  | { readonly state: "stopped"; readonly message?: string }
  | { readonly state: "starting"; readonly port: number; readonly pid?: number }
  | { readonly state: "running"; readonly port: number; readonly pid?: number }
  | { readonly state: "error"; readonly message: string };

const DEFAULT_WIKI_PORT = 4399;
const LOCK_POLL_INTERVAL_MS = 100;
const LOCK_POLL_ATTEMPTS = 50;
const require = createRequire(import.meta.url);

export function createWikiProcessController(options: {
  readonly cwd: string;
  readonly lockPath?: string;
  readonly onChange: () => void;
  readonly spawnProcess?: (port: number) => ChildProcess;
}): WikiProcessController {
  let child: ChildProcess | undefined;
  let port = DEFAULT_WIKI_PORT;
  let status: WikiServerStatus = { state: "stopped" };
  let lockPollTimer: NodeJS.Timeout | undefined;

  return {
    getPort: () => port,
    getStatus: () => status,
    setPort: (nextPort) => {
      port = nextPort;
    },
    start(): void {
      if (child !== undefined) {
        return;
      }
      try {
        const lockPath = options.lockPath ?? resolveWikiLockPath();
        const args = ["--cwd", options.cwd, "--lock", lockPath, "--port", String(port)];
        const nextChild = options.spawnProcess?.(port) ?? spawn(process.execPath, [resolveWikiServerPath(), ...args], {
          cwd: options.cwd,
          detached: true,
          shell: false,
          stdio: "ignore",
        });
        child = nextChild;
        child.unref();
        status = { state: "starting", port, pid: child.pid };
        pollLockForReady(nextChild, lockPath, 0);
        child.once("exit", () => {
          if (child === nextChild) {
            clearLockPoll();
            child = undefined;
            status = { state: "stopped" };
            options.onChange();
          }
        });
        child.once("error", (error) => {
          if (child === nextChild) {
            clearLockPoll();
            child = undefined;
            status = { state: "error", message: error.message };
            options.onChange();
          }
        });
      } catch (error: unknown) {
        status = { state: "error", message: formatError(error) };
      }
      options.onChange();
    },
    stop(): void {
      if (child === undefined) {
        clearLockPoll();
        status = { state: "stopped" };
        options.onChange();
        return;
      }
      child.kill();
      child = undefined;
      clearLockPoll();
      status = { state: "stopped" };
      options.onChange();
    },
  };

  function pollLockForReady(expectedChild: ChildProcess, lockPath: string, attempt: number): void {
    clearLockPoll();
    const lock = readWikiLock(lockPath);
    if (child === expectedChild && lock !== null && lock.pid === expectedChild.pid) {
      status = { state: "running", port: lock.port, pid: expectedChild.pid };
      options.onChange();
      return;
    }
    if (attempt >= LOCK_POLL_ATTEMPTS) {
      if (child === expectedChild) {
        status = { state: "error", message: "Wiki server did not report a ready port." };
        child = undefined;
        expectedChild.kill();
        options.onChange();
      }
      return;
    }
    lockPollTimer = setTimeout(() => {
      pollLockForReady(expectedChild, lockPath, attempt + 1);
    }, LOCK_POLL_INTERVAL_MS);
    lockPollTimer.unref();
  }

  function clearLockPoll(): void {
    if (lockPollTimer !== undefined) {
      clearTimeout(lockPollTimer);
      lockPollTimer = undefined;
    }
  }
}

export function createWikiPanel(deps: WikiPanelDeps): MenuPanel {
  const wiki = deps.wiki ?? createWikiProcessController({ cwd: deps.cwd, onChange: deps.onRenderRequest });

  return {
    id: "fleet-menu:wiki",
    title: "Wiki Server",
    handleInput(data: string): boolean {
      if (isEnter(data)) {
        const status = wiki.getStatus();
        if (status.state === "running") {
          wiki.stop();
        } else {
          wiki.start();
        }
        return true;
      }
      if (data === "P" || data === "p") {
        deps.stack.push(createInputModal({
          title: "Wiki Server Port",
          message: "Set port for this Fleet process.",
          mode: "numeric",
          initialValue: String(wiki.getPort()),
          onRenderRequest: deps.onRenderRequest,
          validate: validatePort,
          onCancel: () => {
            deps.stack.pop();
          },
          onSubmit: (value) => {
            wiki.setPort(Number(value));
            deps.stack.pop();
          },
        }));
        return true;
      }
      return false;
    },
    render({ width }): readonly string[] {
      const status = wiki.getStatus();
      return [
        "",
        centerText(MISSION_CONTROL_THEME.dim(renderBreadcrumbs(deps.stack.breadcrumbs())), width),
        centerText(MISSION_CONTROL_THEME.accent("Wiki Server"), width),
        "",
        centerText(formatStatus(status), width),
        centerText(MISSION_CONTROL_THEME.dim(`Port: ${wiki.getPort()}`), width),
        "",
        centerText(MISSION_CONTROL_THEME.dim("External fleet wiki processes are not managed here."), width),
        "",
        centerText(MISSION_CONTROL_THEME.dim("Enter start or stop  P port  Esc back"), width),
      ];
    },
  };
}

function resolveWikiServerPath(): string {
  return path.join(path.dirname(require.resolve("@dotobokuri/fleet-wiki-ui/dist/cli.mjs")), "server.mjs");
}

function resolveWikiLockPath(): string {
  return path.join("/tmp", `fleet-wiki-${userLockOwner()}`, "fleet-wiki-daemon.lock");
}

function userLockOwner(): string {
  const info = os.userInfo();
  return String(info.uid ?? info.username).replace(/[^A-Za-z0-9._-]/g, "_");
}

function validatePort(value: string): string | undefined {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return "Use port 1024-65535";
  }
  return undefined;
}

function formatStatus(status: WikiServerStatus): string {
  if (status.state === "starting") {
    return MISSION_CONTROL_THEME.warning(`starting :${status.port}`);
  }
  if (status.state === "running") {
    return MISSION_CONTROL_THEME.success(`running :${status.port}`);
  }
  if (status.state === "error") {
    return MISSION_CONTROL_THEME.error(status.message);
  }
  return MISSION_CONTROL_THEME.warning("stopped");
}

function formatError(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "Wiki server failed.";
}

function readWikiLock(lockPath: string): { readonly pid: number; readonly port: number } | null {
  try {
    if (fs.lstatSync(lockPath).isSymbolicLink()) return null;
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { readonly pid?: unknown; readonly port?: unknown };
    const pid = parsed.pid;
    const port = parsed.port;
    if (typeof pid !== "number" || typeof port !== "number") return null;
    if (!Number.isInteger(pid) || !Number.isInteger(port)) return null;
    if (port < 1024 || port > 65535) return null;
    return { pid, port };
  } catch {
    return null;
  }
}
