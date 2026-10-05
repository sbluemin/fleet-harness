import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readConsoleUpdateProgress } from "../features/updates/host/update-progress.js";
import { UPDATE_WORKER_COMMIT_MS, UPDATE_WORKER_PREFLIGHT_MS } from "@fleet-console/protocol/lifecycle";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createHash } from "node:crypto";

import type * as http from "node:http";

import { createConsoleUpdateApplyService } from "../features/updates/host/update-apply.js";
import { createUpdatesRoutes } from "../features/updates/host/routes.js";
import { DESKTOP_CONSOLE_SOURCE_ENV, DESKTOP_CONSOLE_SOURCE_GITHUB_RELEASE, DESKTOP_RESOURCE_ROOT_MARKER, formatDesktopResourceRootMarker } from "@fleet-console/protocol/desktop";
import type { ConsoleReleaseManifest } from "@fleet-console/protocol/release";
import { downloadVerifiedConsoleTarball } from "@fleet-console/updates";

const TEMP_DIRS: string[] = [];
afterEach(() => { for (const dir of TEMP_DIRS.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("console update apply worker", () => {

  it("rejects worker spawn before writing the worker when no current global manager matches", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-update-preflight-"));
    TEMP_DIRS.push(root);
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
      currentLockToken: "token",
      currentLockStartedAt: Date.now(),
      currentPackageRoot: "/not-a-global-install",
      currentPid: 111,
      dataDir: root,
      fromVersion: "1.2.2",
      lockFile: "/tmp/console.lock",
      release: createRelease("1.2.3", Buffer.from("tarball")),
    })).rejects.toMatchObject({ progress: { state: "failed", reason: "preflight-failed", failureStage: "preflight" } });

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

    await expect(service.start({ currentEndpoint: "http://127.0.0.1:4000/", currentLockToken: "token", currentLockStartedAt: Date.now(), currentPackageRoot: latest, currentPid: 111, dataDir: root, fromVersion: "1.2.2", lockFile: path.join(root, "console.lock"), release: createRelease("1.2.3", Buffer.from("tarball")) })).rejects.toThrow("managed_runtime_update_requires_relaunch");
    expect(preflightInstall).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("refuses a release tarball whose bytes do not match the manifest before stopping Console", async () => {
    const fleetDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-update-integrity-"));
    TEMP_DIRS.push(fleetDataDir);
    const release = createRelease("1.2.3", Buffer.from("the published tarball"));
    const tampered = Buffer.from("a different tarball!!");
    const requested: string[] = [];
    const writeFile = vi.fn();
    const spawnWorker = vi.fn(() => { throw new Error("must not spawn"); });
    const service = createConsoleUpdateApplyService({
      fleetDataDir,
      preflightInstall: () => createPackageManagerSpec(),
      downloadTarball: (manifest, releasesDir) => downloadVerifiedConsoleTarball(manifest, {
        releasesDir,
        fetch: async (url) => {
          requested.push(url);
          return new Response(tampered, { status: 200 });
        },
      }),
      writeFile,
      spawnWorker,
    });

    await expect(service.start({ currentEndpoint: "http://127.0.0.1:4000/", currentLockToken: "token", currentLockStartedAt: Date.now(), currentPackageRoot: "/global/root/@dotobokuri/fleet-console", currentPid: 111, dataDir: fleetDataDir, fromVersion: "1.2.2", lockFile: path.join(fleetDataDir, "console.lock"), release })).rejects.toThrow("checksum_mismatch");

    expect(requested).toEqual(["https://github.com/sbluemin/fleet-harness/releases/download/v1.2.3/fleet-console-1.2.3.tgz"]);
    // 검증에 실패한 바이트는 설치 후보로 남지 않고, Console을 멈출 worker도 만들어지지 않는다.
    expect(fs.readdirSync(path.join(fleetDataDir, "console-releases"))).toEqual([]);
    expect(writeFile).not.toHaveBeenCalled();
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("never signals a live pid that did not prove it is the Console being updated", async () => {
    // The Console exited and the OS handed its pid to an unrelated program. That program is alive, the Console
    // endpoint refuses, the lock is gone, and the worker is not that pid's child: nothing proves identity.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-update-containment-"));
    TEMP_DIRS.push(root);
    const signalLog = path.join(root, "unrelated-signals.log");
    const unrelated = spawn(process.execPath, ["-e", `process.on("SIGTERM", () => require("fs").appendFileSync(${JSON.stringify(signalLog)}, "SIGTERM\\n")); setInterval(() => {}, 1 << 30);`], { stdio: "ignore" });
    const daemonPidFile = path.join(root, "new-console.pid");
    try {
      const globalRoot = path.join(root, "global");
      const packageRoot = path.join(globalRoot, "@dotobokuri", "fleet-console");
      fs.mkdirSync(packageRoot, { recursive: true });
      const packageManager = path.join(root, "package-manager.mjs");
      fs.writeFileSync(packageManager, `if (process.argv[2] === "root") console.log(${JSON.stringify(globalRoot)});`);
      const dataDir = path.join(root, "console");
      const lockFile = path.join(dataDir, "console.lock");
      // The next Console: takes the lock and answers health with the target version, like `serve` does.
      const nextConsole = path.join(root, "next-console.mjs");
      fs.writeFileSync(nextConsole, [
        `import fs from "node:fs"; import http from "node:http";`,
        `fs.writeFileSync(${JSON.stringify(daemonPidFile)}, String(process.pid));`,
        `const server = http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ pid: process.pid, version: "1.2.3" })); });`,
        `server.listen(0, "127.0.0.1", () => { const port = server.address().port; fs.writeFileSync(${JSON.stringify(lockFile)}, JSON.stringify({ pid: process.pid, host: "127.0.0.1", port, endpoint: \`http://127.0.0.1:\${port}/\`, startedAt: Date.now(), token: "next", version: "1.2.3" }), { mode: 0o600 }); });`,
      ].join("\n"));
      const service = createConsoleUpdateApplyService({
        env: { PATH: process.env.PATH, TMPDIR: root, FLEET_CONSOLE_NO_SYSTEM_CA: "1" },
        fleetDataDir: root,
        tmpDir: root,
        preflightInstall: () => ({ bin: process.execPath, command: "npm", globalRoot, prefixArgs: [packageManager] }),
        downloadTarball: async () => ({ ok: true, tarballPath: path.join(root, "fleet-console-1.2.3.tgz") }),
        serverModulePath: nextConsole,
        // The built lifecycle runtime, as an installed Console ships it beside its bundle.
        workerRuntimePath: fileURLToPath(new URL("../dist/lifecycle-worker-runtime.mjs", import.meta.url)),
      });

      const prepared = await service.start({
        currentEndpoint: `http://127.0.0.1:${await closedLoopbackPort()}/`,
        currentLockToken: "the-exited-console",
        // The exited Console wrote its lock well before the unrelated program took its pid.
        currentLockStartedAt: Date.now() - 60_000,
        currentPackageRoot: packageRoot,
        currentPid: unrelated.pid!,
        dataDir,
        fromVersion: "1.2.2",
        lockFile,
        release: createRelease("1.2.3", Buffer.from("tarball")),
      });

      await prepared.commit();
      const progressFile = path.join(dataDir, "update-progress.json");
      await vi.waitFor(() => {
        expect(JSON.parse(fs.readFileSync(progressFile, "utf8")).phase).toBe("completed");
      }, { timeout: 20_000, interval: 100 });
      expect(unrelated.exitCode).toBeNull();
      expect(unrelated.signalCode).toBeNull();
      expect(fs.existsSync(signalLog)).toBe(false);
    } finally {
      unrelated.kill("SIGKILL");
      try { process.kill(Number(fs.readFileSync(daemonPidFile, "utf8")), "SIGKILL"); } catch { /* never started */ }
    }
  }, 30_000);

  // host의 검사가 통과한 뒤 실제 worker에서만 실패하는 public apply 경계다.
  it.each(["failure", "hung"] as const)("keeps the Console serving when worker preflight is %s", async (mode) => {
    const fixture = workerFixture(mode);
    const stop = vi.fn(async () => undefined);
    const routes = applyRoutes(fixture, stop);
    const response = new EventEmitter() as http.ServerResponse & { result: { status: number; body: any } };
    await routes.handleUpdateApply({ method: "POST", headers: {} } as http.IncomingMessage, response);
    expect(response.result.status).toBe(503);
    const progress = response.result.body.progress;
    expect(progress).toMatchObject({ state: "failed", phase: "failed", reason: mode === "hung" ? "preflight-timeout" : "preflight-failed", failureStage: "preflight", fromVersion: "1.2.2", targetVersion: "1.2.3" });
    expect(progress.startedAt).toBeTruthy();
    expect(progress.description).toBeTruthy();
    expect(JSON.stringify(progress)).not.toContain(fixture.root);
    expect(readConsoleUpdateProgress(fixture.root)).toMatchObject(progress);
    expect(stop).not.toHaveBeenCalled();
    expect(fs.readFileSync(fixture.calls, "utf8").trim().split("\n")).toEqual(["root", "root"]);
    expect(fs.existsSync(fixture.serveMarker)).toBe(false);
    // 거절한 실행은 자리를 비우며, 다음 실행의 식별자는 지난 결과 확인과 충돌하지 않는다.
    if (mode === "failure") {
      await routes.handleUpdateApply({ method: "POST", headers: {} } as http.IncomingMessage, response);
      expect(response.result.status).toBe(503);
      expect(response.result.body.progress.startedAt).not.toBe(progress.startedAt);
    }
  }, UPDATE_WORKER_PREFLIGHT_MS + 10_000);

  it("retires an uncommitted ready worker without signalling, installing, or recovering", async () => {
    const fixture = workerFixture("ready");
    const prepared = await fixture.service.start(fixture.request);
    await prepared.cancelled;
    await expect(prepared.commit()).rejects.toThrow();
    expect(readConsoleUpdateProgress(fixture.root)).toMatchObject({ state: "failed", reason: "handoff-aborted", failureStage: "handoff" });
    expect(fs.readFileSync(fixture.calls, "utf8").trim().split("\n")).toEqual(["root", "root"]);
    expect(fs.existsSync(fixture.serveMarker)).toBe(false);
  }, UPDATE_WORKER_COMMIT_MS + 10_000);

  it("aborts a prepared worker when the accepted response closes before finish", async () => {
    const fixture = workerFixture("ready");
    const stop = vi.fn(async () => undefined);
    const routes = applyRoutes(fixture, stop, true);
    const response = new EventEmitter() as http.ServerResponse;
    await routes.handleUpdateApply({ method: "POST", headers: {} } as http.IncomingMessage, response);
    expect(stop).not.toHaveBeenCalled();
    expect(readConsoleUpdateProgress(fixture.root)).toMatchObject({ state: "failed", reason: "handoff-aborted" });
    expect(fs.readFileSync(fixture.calls, "utf8").trim().split("\n")).toEqual(["root", "root"]);
  });

  it("hands one Desktop relaunch per update and answers a second apply as already in progress", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-update-delegated-"));
    TEMP_DIRS.push(root);
    const latest = path.join(root, "console", "latest");
    fs.mkdirSync(latest, { recursive: true });
    fs.writeFileSync(path.join(latest, DESKTOP_RESOURCE_ROOT_MARKER), formatDesktopResourceRootMarker());
    let clock = 1_000_000;
    let releaseRefresh: () => void = () => undefined;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const published: { readonly requestedVersion: string; readonly requestId: string }[] = [];
    const routes = createUpdatesRoutes({
      releaseNotes: {} as never,
      updateCheck: { refresh: async () => { await refreshGate; return { updateAvailable: true, latestVersion: "1.2.3" }; } } as never,
      updateApply: { start: async () => { throw new Error("a managed runtime must not update in place"); } },
      durablePaths: { dir: root },
      release: { packageRoot: latest },
      version: "1.2.2",
      channel: "stable",
      isExactConsoleOrigin: () => true,
      isLoopbackListener: () => true,
      readJsonBody: async <T,>() => ({}) as T,
      writeJson: (res, status, body) => { (res as unknown as { result: unknown }).result = { status, body }; },
      readUrl: () => new URL("http://127.0.0.1/"),
      currentRuntime: () => ({ lockHandle: null, activeEndpoint: null, activeLockFile: null }),
      publishDesktopUpdateRequest: (request) => { published.push(request); },
      env: { [DESKTOP_CONSOLE_SOURCE_ENV]: DESKTOP_CONSOLE_SOURCE_GITHUB_RELEASE },
      now: () => clock,
      stopAfterAcceptedUpdateApply: async () => undefined,
    });
    const apply = async () => {
      const res = {} as { result?: { readonly status: number; readonly body: unknown } };
      await routes.handleUpdateApply({ method: "POST", headers: {} } as http.IncomingMessage, res as unknown as http.ServerResponse);
      return res.result;
    };

    // 두 탭이 거의 동시에 누른다 — 첫 요청이 Release를 다시 묻는 사이 두 번째가 들어온다.
    const first = apply();
    const second = apply();
    releaseRefresh();
    expect(await first).toEqual({ status: 202, body: { status: "delegated" } });
    expect(await second).toEqual({ status: 409, body: { error: "update_already_in_progress" } });
    // 셸이 재시작을 시작하기 전에 다시 눌러도 새 요청표는 나가지 않는다.
    expect(await apply()).toEqual({ status: 409, body: { error: "update_already_in_progress" } });
    expect(published).toHaveLength(1);

    // 셸이 끝내 재시작하지 않으면 이 Console이 그대로 서 있다. 화면이 포기하는 만큼 기다린 뒤에는 다시 시도할 수 있다.
    clock += 60_001;
    expect(await apply()).toEqual({ status: 202, body: { status: "delegated" } });
    expect(published).toHaveLength(2);
  });

});

function workerFixture(mode: "failure" | "hung" | "ready") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-update-barrier-"));
  TEMP_DIRS.push(root);
  const globalRoot = path.join(root, "global");
  const packageRoot = path.join(globalRoot, "@dotobokuri", "fleet-console");
  fs.mkdirSync(packageRoot, { recursive: true });
  const calls = path.join(root, "calls");
  const manager = path.join(root, "npm.mjs");
  fs.writeFileSync(manager, `import fs from "node:fs";
const calls = ${JSON.stringify(calls)};
const first = !fs.existsSync(calls);
fs.appendFileSync(calls, process.argv[2] + "\\n");
if (first || ${JSON.stringify(mode)} === "ready") console.log(${JSON.stringify(globalRoot)});
else if (${JSON.stringify(mode)} === "hung") setInterval(() => {}, 1000);
else process.exitCode = 1;
`);
  const serveMarker = path.join(root, "serve-called");
  const serve = path.join(root, "serve.mjs");
  fs.writeFileSync(serve, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(serveMarker)}, "unexpected");`);
  const service = createConsoleUpdateApplyService({
    env: { PATH: process.env.PATH, TMPDIR: root, FLEET_CONSOLE_NO_SYSTEM_CA: "1" },
    fleetDataDir: root, tmpDir: root,
    preflightInstall: () => {
      execFileSync(process.execPath, [manager, "root", "-g"]);
      return { bin: process.execPath, command: "npm", globalRoot, prefixArgs: [manager] };
    },
    downloadTarball: async () => ({ ok: true, tarballPath: path.join(root, "release.tgz") }),
    serverModulePath: serve,
    workerRuntimePath: fileURLToPath(new URL("../dist/lifecycle-worker-runtime.mjs", import.meta.url)),
  });
  const request = {
    currentEndpoint: "http://127.0.0.1:1/", currentLockToken: "fixture", currentLockStartedAt: Date.now(),
    currentPackageRoot: packageRoot, currentPid: process.pid, dataDir: root, fromVersion: "1.2.2",
    lockFile: path.join(root, "console.lock"), release: createRelease("1.2.3", Buffer.from("fixture")),
  };
  return { root, calls, serveMarker, service, request };
}

function applyRoutes(fixture: ReturnType<typeof workerFixture>, stop: () => Promise<void>, closeBeforeFinish = false) {
  return createUpdatesRoutes({
    releaseNotes: {} as never,
    updateCheck: { refresh: async () => ({ updateAvailable: true, latestVersion: "1.2.3" }), latestRelease: () => fixture.request.release } as never,
    updateApply: fixture.service, durablePaths: { dir: fixture.root },
    release: { packageRoot: fixture.request.currentPackageRoot }, version: "1.2.2", channel: "stable",
    isExactConsoleOrigin: () => true, isLoopbackListener: () => true,
    readJsonBody: async <T,>() => ({}) as T,
    writeJson: (res, status, body) => {
      Object.assign(res, { result: { status, body } });
      res.emit(closeBeforeFinish ? "close" : "finish");
    },
    readUrl: () => new URL("http://127.0.0.1/"),
    currentRuntime: () => ({ lockHandle: { payload: { token: "fixture", startedAt: fixture.request.currentLockStartedAt } }, activeEndpoint: fixture.request.currentEndpoint, activeLockFile: fixture.request.lockFile }),
    publishDesktopUpdateRequest: () => {}, stopAfterAcceptedUpdateApply: stop,
  });
}

function createRelease(version: string, bytes: Buffer): ConsoleReleaseManifest {
  return {
    schema: 1,
    package: "@dotobokuri/fleet-console",
    version,
    tag: `v${version}`,
    tarball: { name: `fleet-console-${version}.tgz`, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") },
  };
}

async function closedLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function createPackageManagerSpec() {
  return {
    bin: "/resolved/npm.cmd",
    command: "npm" as const,
    globalRoot: "/global/root",
    prefixArgs: ["/d", "/s", "/c", "call", "/resolved/npm.cmd "],
  };
}
