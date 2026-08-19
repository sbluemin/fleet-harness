import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createConsoleUpdateApplyService, emitConsoleUpdateWorkerScript, type ConsoleUpdateWorkerScriptConfig } from "../core/host/update-apply.js";
import { DESKTOP_RESOURCE_ROOT_MARKER, formatDesktopResourceRootMarker } from "@fleet-console/desktop-protocol";

const TEMP_DIRS: string[] = [];
afterEach(() => { for (const dir of TEMP_DIRS.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("console update apply worker", () => {
  it("emits a standalone worker script that uses only allowed Node built-ins", () => {
    const script = emitConsoleUpdateWorkerScript(createConfig());

    expect(script).toContain('from "node:child_process"');
    expect(script).toContain('from "node:fs"');
    expect(script).toContain('from "node:os"');
    expect(script).toContain('from "node:path"');
    expect(script).not.toContain('from "@dotobokuri/fleet-cli"');
    expect(script).not.toContain("runtime/fleet-cli");
    expect(script).not.toContain('from "open"');
    expect(script).toContain('"@dotobokuri/fleet-console"');
    expect(script).toContain('"@dotobokuri/fleet-console"');
    expect(script).toContain('"serve"');
    // 워커가 교체 데몬을 띄울 때 process.env를 그대로 넘기는 계약 — 서비스의 child env 주입(예: NODE_USE_SYSTEM_CA)이 데몬까지 도달하는 경로다.
    // 되찾을 포트가 그 위에 얹히더라도 상속 자체는 끊기지 않는다.
    expect(script).toContain("env: daemonEnv()");
    expect(script).toContain("if (config.resumePort === null) return process.env;");
    expect(script).toContain("return { ...process.env, FLEET_CONSOLE_RESUME_PORT: String(config.resumePort) };");
    // 같은 주소로 돌아왔으면 새 창을 열지 않는다 — 복귀는 원래 창의 몫이다.
    expect(script).toContain("if (endpointChanged) openBrowser(");
    // 설치가 실패해도 콘솔은 다시 서야 한다. 실패를 읽을 화면이 그것뿐이다.
    expect(script).toContain("if (consoleStopped) await recoverConsoleBestEffort();");
    // 재기동한 데몬이 읽는 고정 이름의 기록.
    expect(script).toContain("config.progressFile");
    // SIGKILL로 내린 콘솔은 정의상 락을 남긴다. 그 락이 사라지기를 기다리면 업데이트는
    // 늘 시간 초과로 끝나므로, 프로세스가 사라진 것만으로 정지를 인정하고 락은 워커가 치운다.
    expect(script).toContain("if (pidGone && healthGone) {");
    expect(script).toContain("function removeStaleLock()");
    expect(script).not.toContain("const lockGone");
    expect(script).toContain('"/resolved/npm.cmd"');
    expect(script).toContain('"/d","/s","/c","call","/resolved/npm.cmd "');
    expect(script).toContain("ensureGlobalRootWritable(manager)");
    expect(script).toContain("writeStatus(\"preflight-ok\"");
    expect(script).toContain("new health response did not expose a version; waiting for verified target");
    expect(script).toContain("return version === config.targetVersion;");
    expect(script).toContain('execFileSync(configured.bin, [...configured.prefixArgs, "root", "-g"]');
    expect(script).toContain('spawnExit(manager.bin, [...manager.prefixArgs, "i", "-g", "--force"');
    expect(script).not.toContain('if (command === "npm") return { command };');
    expect(script).not.toContain('execFileSync(command, ["root", "-g"]');
    expect(script).not.toContain('spawnExit(manager.command, ["i", "-g", "--force"');
    expect(script).not.toContain("target verification skipped");
  });

  it("writes a temporary mjs worker and spawns it detached before returning", async () => {
    const writes: Array<{ readonly filePath: string; readonly content: string; readonly mode: number }> = [];
    const unref = vi.fn();
    const spawned: Array<{ readonly execPath: string; readonly args: readonly string[]; readonly options: unknown }> = [];
    const service = createConsoleUpdateApplyService({
      env: { PATH: "/bin" },
      execPath: "/node",
      makeDir: vi.fn(),
      now: () => 123,
      preflightInstall: () => createPackageManagerSpec(),
      processPid: 456,
      serverModulePath: "/pkg/dist/cli.mjs",
      tmpDir: "/tmp",
      writeFile: (filePath, content, options) => {
        writes.push({ filePath, content, mode: options.mode });
      },
      spawnWorker: (execPath, args, options) => {
        spawned.push({ execPath, args, options });
        return {
          once: vi.fn().mockReturnThis(),
          unref,
        };
      },
    });

    await expect(service.start({
      currentEndpoint: "http://127.0.0.1:4000/",
      currentPackageRoot: "/pkg",
      currentPid: 111,
      dataDir: "/data/console",
      fromVersion: "1.2.2",
      lockFile: "/tmp/console.lock",
      targetVersion: "1.2.3",
    })).resolves.toEqual({ accepted: true });

    // 워커 스크립트 하나와, 수락 시점의 진행 기록 하나. 후자가 없으면 워커가 첫 줄을
    // 쓰기 전에 새로고침한 화면이 "아무 일도 없다"는 답을 받는다.
    expect(writes).toHaveLength(2);
    expect(writes[1]?.filePath).toBe("/data/console/update-progress.json");
    expect(JSON.parse(writes[1]?.content ?? "{}")).toMatchObject({
      phase: "starting",
      fromVersion: "1.2.2",
      targetVersion: "1.2.3",
    });
    expect(writes[0]?.filePath).toBe("/tmp/fleet-console-update-123-456.mjs");
    expect(writes[0]?.content).toContain("/data/console/fleet-console-update-123-456.status.json");
    expect(writes[0]?.content).toContain("/data/console/fleet-console-update-123-456.log");
    expect(writes[0]?.content).toContain('"/resolved/npm.cmd"');
    expect(writes[0]?.mode).toBe(0o600);
    expect(spawned).toEqual([{
      execPath: "/node",
      args: ["/tmp/fleet-console-update-123-456.mjs"],
      options: { detached: true, env: { PATH: "/bin", NODE_USE_SYSTEM_CA: "1" }, stdio: "ignore", windowsHide: true },
    }]);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it.each([
    { env: { FLEET_CONSOLE_NO_SYSTEM_CA: "1" }, expected: { FLEET_CONSOLE_NO_SYSTEM_CA: "1" } },
    { env: { NODE_USE_SYSTEM_CA: "0" }, expected: { NODE_USE_SYSTEM_CA: "0" } },
  ])("passes the configured system CA environment to the update worker: $expected", async ({ env, expected }) => {
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    const service = createConsoleUpdateApplyService({
      env,
      execPath: "/node",
      makeDir: vi.fn(),
      now: () => 123,
      preflightInstall: () => createPackageManagerSpec(),
      processPid: 456,
      serverModulePath: "/pkg/dist/cli.mjs",
      tmpDir: "/tmp",
      writeFile: vi.fn(),
      spawnWorker: (_execPath, _args, options) => {
        spawnedEnv = options.env;
        return {
          once: vi.fn().mockReturnThis(),
          unref: vi.fn(),
        };
      },
    });

    await service.start({
      currentEndpoint: "http://127.0.0.1:4000/",
      currentPackageRoot: "/pkg",
      currentPid: 111,
      dataDir: "/data/console",
      fromVersion: "1.2.2",
      lockFile: "/tmp/console.lock",
      targetVersion: "1.2.3",
    });

    expect(spawnedEnv).toEqual(expected);
  });

  it("rejects worker spawn before writing the worker when no current global manager matches", async () => {
    const writes: string[] = [];
    const service = createConsoleUpdateApplyService({
      preflightInstall: () => {
        throw new Error("no supported global package manager found");
      },
      tmpDir: "/tmp",
      writeFile: (filePath) => {
        writes.push(filePath);
      },
      spawnWorker: () => {
        throw new Error("must not spawn");
      },
    });

    await expect(service.start({
      currentEndpoint: "http://127.0.0.1:4000/",
      currentPackageRoot: "/not-a-global-install",
      currentPid: 111,
      dataDir: "/data/console",
      fromVersion: "1.2.2",
      lockFile: "/tmp/console.lock",
      targetVersion: "1.2.3",
    })).rejects.toThrow("no supported global package manager found");

    expect(writes).toEqual([]);
  });

  it("refuses a marked managed console/latest layout before it can stop or mutate a live runtime", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-update-managed-"));
    TEMP_DIRS.push(root);
    const latest = path.join(root, "console", "latest");
    fs.mkdirSync(latest, { recursive: true });
    fs.writeFileSync(path.join(latest, DESKTOP_RESOURCE_ROOT_MARKER), formatDesktopResourceRootMarker());
    const preflightInstall = vi.fn(() => createPackageManagerSpec());
    const writeFile = vi.fn();
    const service = createConsoleUpdateApplyService({ preflightInstall, writeFile, spawnWorker: () => { throw new Error("must not spawn"); } });

    await expect(service.start({ currentEndpoint: "http://127.0.0.1:4000/", currentPackageRoot: latest, currentPid: 111, dataDir: root, fromVersion: "1.2.2", lockFile: path.join(root, "console.lock"), targetVersion: "1.2.3" })).rejects.toThrow("managed_runtime_update_requires_relaunch");
    expect(preflightInstall).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

});

function createConfig(): ConsoleUpdateWorkerScriptConfig {
  return {
    currentEndpoint: "http://127.0.0.1:4000/",
    currentPackageRoot: "/pkg",
    currentPid: 111,
    fromVersion: "1.2.2",
    lockFile: "/tmp/console.lock",
    logFile: "/tmp/fleet-console-update.log",
    packageManager: createPackageManagerSpec(),
    packageNames: ["@dotobokuri/fleet-console"],
    progressFile: "/data/console/update-progress.json",
    resumePort: 4000,
    serverModulePath: "/pkg/dist/cli.mjs",
    startedAt: "2026-08-19T00:00:00.000Z",
    statusFile: "/tmp/fleet-console-update.status.json",
    targetVersion: "1.2.3",
    workerPath: "/tmp/fleet-console-update.mjs",
  };
}

function createPackageManagerSpec() {
  return {
    bin: "/resolved/npm.cmd",
    command: "npm" as const,
    globalRoot: "/global/root",
    prefixArgs: ["/d", "/s", "/c", "call", "/resolved/npm.cmd "],
  };
}
