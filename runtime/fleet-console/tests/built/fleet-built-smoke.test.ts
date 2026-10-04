import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveSiblingConsoleCliPath } from "../../cli/update/stop-console.js";
import { resolveDefaultServerModulePath } from "../../core/host/bootstrap/console-lifecycle.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fleetDist = path.join(packageRoot, "dist", "fleet.mjs");
const cliDist = path.join(packageRoot, "dist", "cli.mjs");
const desktopProtocolDist = path.join(packageRoot, "dist", "desktop-protocol.mjs");

const runBuiltSmoke = process.env.FLEET_BUILT_SMOKE === "1";

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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-rejection-"));
    const slot = path.join(root, "console");
    const lock = path.join(slot, "console.lock");
    const log = path.join(slot, "errors.jsonl");
    const preload = path.join(root, "inject.mjs");
    // Test-only preload: no production fault-injection switch or modified source bundle.
    fs.writeFileSync(preload, `import fs from 'node:fs';\nconst timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(lock)})) return; clearInterval(timer); Promise.reject(new Error('request_path_rejection_probe')); }, 25);\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, FLEET_DATA_DIR: root, FLEET_CONSOLE_DATA_DIR: slot };
    delete env.INIT_CWD;
    // --import takes a module specifier: a bare Windows path (C:\...) reads as a "c:" URL scheme and Node exits.
    const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, cliDist, "serve"], { env, stdio: "ignore" });
    try {
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
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), new Promise<void>((resolve) => setTimeout(resolve, 3_000))]);
      }
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);

  // POSIX 신호 계약이다. Windows의 kill은 신호 없이 프로세스를 끝내므로 정상 종료 경로 자체가 없다.
  it.skipIf(process.platform === "win32")("finishes its shutdown when SIGTERM and SIGINT arrive again mid-cleanup", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-resignal-"));
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
      // rmSync deletes a file through unlinkSync, so count only the outermost call per removal.
      "let inside = false;",
      "for (const name of ['rmSync', 'unlinkSync']) {",
      "  const original = fs[name];",
      "  fs[name] = function (target, ...rest) {",
      "    if (inside || String(target) !== lock) return original.call(this, target, ...rest);",
      "    inside = true;",
      "    try { fs.appendFileSync(stalled, 'lock-release\\n'); while (!fs.existsSync(release)) Atomics.wait(pause, 0, 0, 10); return original.call(this, target, ...rest); }",
      "    finally { inside = false; }",
      "  };",
      "}",
      "syncBuiltinESMExports();",
    ].join("\n"));
    const env: NodeJS.ProcessEnv = { ...process.env, FLEET_DATA_DIR: root, FLEET_CONSOLE_DATA_DIR: slot };
    delete env.INIT_CWD;
    const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, cliDist, "serve"], { env, stdio: "ignore" });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    try {
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
      // The repeated signals did not start the cleanup a second time.
      expect(fs.readFileSync(stalled, "utf8")).toBe("lock-release\n");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);
});

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`${path.basename(file)} did not appear within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
