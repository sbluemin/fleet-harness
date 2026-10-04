import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { resolveSiblingConsoleCliPath } from "../../cli/update/stop-console.js";
import { resolveDefaultServerModulePath } from "../../core/host/bootstrap/console-lifecycle.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fleetDist = path.join(packageRoot, "dist", "fleet.mjs");
const cliDist = path.join(packageRoot, "dist", "cli.mjs");
const desktopProtocolDist = path.join(packageRoot, "dist", "desktop-protocol.mjs");

const runBuiltSmoke = process.env.FLEET_BUILT_SMOKE === "1";

// 실프로세스 serve와 임시 루트는 테스트 본문이 아니라 여기서 정리한다 — 끝나지 않는 await에 걸린 본문은
// 타임아웃 뒤에도 finally에 도달하지 못해 serve가 남는다.
const SERVES = new Set<ChildProcess>();
const ROOTS: string[] = [];

afterEach(async () => {
  await Promise.all([...SERVES].map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
  }));
  SERVES.clear();
  for (const root of ROOTS.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

(runBuiltSmoke ? describe : describe.skip)("built dual-entry smoke", () => {
  it("requires built dual-entry artifacts", () => {
    expect(fs.existsSync(fleetDist), "run pnpm --filter @dotobokuri/fleet-console build first").toBe(true);
    expect(fs.existsSync(cliDist)).toBe(true);
    expect(fs.existsSync(desktopProtocolDist)).toBe(true);
  });

  it("resolves sibling dist/cli.mjs from the built fleet entry URL", () => {
    const fleetModuleUrl = pathToFileURL(fleetDist).href;
    expect(resolveSiblingConsoleCliPath(fleetModuleUrl)).toBe(cliDist);
    expect(resolveDefaultServerModulePath(fleetModuleUrl)).toBe(cliDist);
    expect(resolveDefaultServerModulePath(fleetModuleUrl)).not.toBe(fleetDist);
  });

  it("prints Fleet help from dist/fleet.mjs --help", () => {
    const result = spawnSync(process.execPath, [fleetDist, "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("console             start · stop · restart · status");
    expect(result.stdout).not.toContain("console             start · stop · restart · status · help");
    expect(result.stdout).toContain("Unrecognized arguments are passed through to Claude Code.");
  });

  it("prints Console help from dist/cli.mjs --help without Gateway passthrough notes", () => {
    const result = spawnSync(process.execPath, [cliDist, "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("fleet console");
    expect(result.stdout).toContain("fleet-console");
    expect(result.stdout).not.toContain("Gateway");
  });

  it("rejects unknown fleet console modes without Claude passthrough", () => {
    const result = spawnSync(process.execPath, [fleetDist, "console", "unknown-mode"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown fleet console command: unknown-mode");
    expect(result.stdout).not.toContain("Unrecognized arguments are passed through to Claude Code.");
  });

  it("keeps the served Console healthy and records a detached rejection", async () => {
    const root = createRoot("fleet-console-rejection-");
    const slot = path.join(root, "console");
    const lock = path.join(slot, "console.lock");
    const log = path.join(slot, "errors.jsonl");
    const preload = path.join(root, "inject.mjs");
    // Test-only preload: no production fault-injection switch or modified source bundle.
    fs.writeFileSync(preload, `import fs from 'node:fs';\nconst timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(lock)})) return; clearInterval(timer); Promise.reject(new Error('request_path_rejection_probe')); }, 25);\n`);
    const child = spawnServe(preload, root, slot);
    let payload: { endpoint: string; token: string } | null = null;
    let diagnostic: { kind: string; message: string; stack: string | null } | null = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Console exited before the rejection was observed: ${child.exitCode ?? child.signalCode}`);
      try {
        payload = JSON.parse(fs.readFileSync(lock, "utf8"));
        const lines = fs.readFileSync(log, "utf8").trim().split("\n");
        diagnostic = JSON.parse(lines.at(-1)!);
        if (diagnostic?.message === "request_path_rejection_probe") break;
      } catch { /* Wait for startup and the diagnostic. */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(diagnostic).toMatchObject({ kind: "unhandledRejection", message: "request_path_rejection_probe" });
    expect(diagnostic?.stack).toContain("request_path_rejection_probe");
    expect(payload).not.toBeNull();
    const response = await fetch(new URL("/api/v1/health", payload!.endpoint), { headers: { authorization: `Bearer ${payload!.token}` } });
    expect(response.ok).toBe(true);
    expect(child.exitCode).toBeNull();
  }, 25_000);

  // POSIX 신호 계약이다. Windows의 kill은 신호 없이 프로세스를 끝내므로 정상 종료 경로 자체가 없다.
  it.skipIf(process.platform === "win32")("finishes its shutdown when SIGTERM and SIGINT arrive again mid-cleanup", async () => {
    const root = createRoot("fleet-console-resignal-");
    const slot = path.join(root, "console");
    const lock = path.join(slot, "console.lock");
    const ready = path.join(root, "ready");
    const stalled = path.join(root, "stalled");
    const release = path.join(root, "release");
    const preload = path.join(root, "stall.mjs");
    // Test-only preload: marks when serve starts listening for SIGTERM, and holds the last cleanup step (lock release)
    // until the release file exists, so the repeated signals land mid-cleanup.
    fs.writeFileSync(preload, [
      "import fs from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      `const lock = ${JSON.stringify(lock)}, ready = ${JSON.stringify(ready)}, stalled = ${JSON.stringify(stalled)}, release = ${JSON.stringify(release)};`,
      "const on = process.on;",
      "process.on = function (event, listener) { const result = on.call(this, event, listener); if (event === 'SIGTERM') fs.writeFileSync(ready, ''); return result; };",
      "const pause = new Int32Array(new SharedArrayBuffer(4));",
      "for (const name of ['rmSync', 'unlinkSync']) {",
      "  const original = fs[name];",
      "  fs[name] = function (target, ...rest) {",
      "    if (String(target) === lock) { fs.writeFileSync(stalled, ''); while (!fs.existsSync(release)) Atomics.wait(pause, 0, 0, 10); }",
      "    return original.call(this, target, ...rest);",
      "  };",
      "}",
      "syncBuiltinESMExports();",
    ].join("\n"));
    const child = spawnServe(preload, root, slot);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    await waitForFile(ready, 15_000);
    child.kill("SIGTERM");
    await waitForFile(stalled, 10_000);
    child.kill("SIGTERM");
    child.kill("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(child.signalCode).toBeNull();
    expect(child.exitCode).toBeNull();
    fs.writeFileSync(release, "");
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(fs.existsSync(lock)).toBe(false);
  }, 40_000);
});

function createRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  ROOTS.push(root);
  return root;
}

function spawnServe(preload: string, root: string, slot: string): ChildProcess {
  // 실행 중인 Console에서 상속한 FLEET_*(resume port, legacy dir 등)가 격리된 serve로 새지 않게 모두 걷어 낸다.
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("FLEET_") && key !== "INIT_CWD"));
  env.FLEET_DATA_DIR = root;
  env.FLEET_CONSOLE_DATA_DIR = slot;
  // --import takes a module specifier: a bare Windows path (C:\...) reads as a "c:" URL scheme and Node exits.
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, cliDist, "serve"], { env, stdio: "ignore" });
  SERVES.add(child);
  return child;
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`${path.basename(file)} did not appear within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
