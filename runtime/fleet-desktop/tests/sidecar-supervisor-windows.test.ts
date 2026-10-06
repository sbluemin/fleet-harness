import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

import { isPidAlive } from "@fleet-console/lifecycle";
import { consoleExitRecordPath, parseConsoleExitRecord } from "@fleet-console/protocol/lifecycle";

import { createDesktopEnvironment } from "../src/environment.js";
import { SidecarSupervisor } from "../src/sidecar-supervisor.js";

const requireFromTest = createRequire(import.meta.url);
const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");

const DIRS: string[] = [];
let sidecarPid: number | null = null;

async function waitUntil(condition: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// N9-W2: Desktop Quit on Windows. The supervisor asks its Console through the token-authenticated stop request, so
// Quit ends in the Console's own cleanup with an exit record of clean — never TerminateProcess with no record. The
// Windows canary lifecycle job runs this file; every other host skips it.
describe.skipIf(process.platform !== "win32")("sidecar supervisor Windows Quit", () => {
  it("quits a built Console through a stop request and records clean", async () => {
    const cliPath = requireFromTest.resolve("@dotobokuri/fleet-console/cli");
    const serviceRoot = path.dirname(path.dirname(cliPath));
    const serviceVersion = (JSON.parse(fs.readFileSync(path.join(serviceRoot, "package.json"), "utf8")) as { version: string }).version;
    const base = path.join(repoRoot, ".fleet", "isolated", "lifecycle");
    fs.mkdirSync(base, { recursive: true });
    const dir = fs.mkdtempSync(path.join(base, "desktop-windows-quit-"));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-lifecycle-desktop-win-"));
    DIRS.push(dir, tmp);
    const root = path.join(dir, "root");
    const slot = path.join(root, "console");
    const home = path.join(dir, "home");
    for (const target of [root, slot, home]) fs.mkdirSync(target, { recursive: true });
    const lockFile = path.join(slot, "console.lock");
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
    const user = os.userInfo().username;
    // Built from nothing, never inherited, so a Console that launched this suite cannot lend it its slot or session marker.
    const baseEnv: NodeJS.ProcessEnv = {
      HOME: home,
      TMP: tmp,
      TEMP: tmp,
      TMPDIR: tmp,
      PATH: [path.dirname(process.execPath), path.join(systemRoot, "System32")].join(";"),
      PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
      // PowerShell hangs past its start-time timeout without its module path (N9-W2); pass the runner's through.
      PSModulePath: process.env.PSModulePath ?? path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules"),
      SystemRoot: systemRoot,
      USER: user,
      USERNAME: user,
      LANG: "en_US.UTF-8",
      FLEET_DATA_DIR: root,
      FLEET_CONSOLE_DATA_DIR: slot,
      FLEET_DESKTOP_DATA_DIR: path.join(dir, "desktop"),
      CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
    const desktop = createDesktopEnvironment(path.join(dir, "userdata"), "0.0.0-lifecycle", serviceRoot, false, baseEnv);
    expect(path.join(desktop.consoleDir, "console.lock")).toBe(lockFile);
    const lines: string[] = [];
    const supervisor = new SidecarSupervisor({
      nodePath: process.execPath,
      cliPath,
      serviceRoot,
      serviceVersion,
      env: desktop.serviceEnv,
      lockFile,
      ownerId: desktop.ownerId,
      log: { info: (message) => { lines.push(message); }, error: (message) => { lines.push(message); } },
    });

    const endpoint = await supervisor.startOrAdopt();
    expect(new URL(endpoint).hostname).toBe("127.0.0.1");
    const published = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid: number; startedAt: number };
    const consolePid = published.pid;
    sidecarPid = consolePid;
    expect(isPidAlive(consolePid)).toBe(true);

    // Desktop Quit: returns once the Console is gone, after its own cleanup.
    await supervisor.stop();
    await waitUntil(() => !isPidAlive(consolePid), 30_000, "the Console outlived Quit");
    sidecarPid = null;

    const record = parseConsoleExitRecord(fs.readFileSync(consoleExitRecordPath(lockFile, { pid: consolePid, lockStartedAt: published.startedAt }), "utf8"));
    expect(record?.outcome).toBe("clean");
    expect(record?.stopReason).toBe("request");
    expect(lines.some((line) => line.includes("console_stop") && line.includes("delivered") && line.includes("outcome=clean"))).toBe(true);
  }, 90_000);
});

async function cleanup(): Promise<void> {
  if (sidecarPid !== null && isPidAlive(sidecarPid)) {
    try {
      process.kill(sidecarPid, "SIGKILL");
    } catch { /* Already gone. */ }
    const pid = sidecarPid;
    await waitUntil(() => !isPidAlive(pid), 10_000, "the sidecar survived SIGKILL").catch(() => {});
  }
  sidecarPid = null;
  for (const dir of DIRS.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

afterEach(async () => { await cleanup(); });
