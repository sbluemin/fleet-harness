import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
      release: createRelease("1.2.3", Buffer.from("tarball")),
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

    await expect(service.start({ currentEndpoint: "http://127.0.0.1:4000/", currentPackageRoot: latest, currentPid: 111, dataDir: root, fromVersion: "1.2.2", lockFile: path.join(root, "console.lock"), release: createRelease("1.2.3", Buffer.from("tarball")) })).rejects.toThrow("managed_runtime_update_requires_relaunch");
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

    await expect(service.start({ currentEndpoint: "http://127.0.0.1:4000/", currentPackageRoot: "/global/root/@dotobokuri/fleet-console", currentPid: 111, dataDir: fleetDataDir, fromVersion: "1.2.2", lockFile: path.join(fleetDataDir, "console.lock"), release })).rejects.toThrow("checksum_mismatch");

    expect(requested).toEqual(["https://github.com/sbluemin/fleet-harness/releases/download/v1.2.3/fleet-console-1.2.3.tgz"]);
    // 검증에 실패한 바이트는 설치 후보로 남지 않고, Console을 멈출 worker도 만들어지지 않는다.
    expect(fs.readdirSync(path.join(fleetDataDir, "console-releases"))).toEqual([]);
    expect(writeFile).not.toHaveBeenCalled();
    expect(spawnWorker).not.toHaveBeenCalled();
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

function createRelease(version: string, bytes: Buffer): ConsoleReleaseManifest {
  return {
    schema: 1,
    package: "@dotobokuri/fleet-console",
    version,
    tag: `v${version}`,
    tarball: { name: `fleet-console-${version}.tgz`, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") },
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
