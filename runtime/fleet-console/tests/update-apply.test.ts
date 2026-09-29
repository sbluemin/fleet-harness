import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createHash } from "node:crypto";

import { createConsoleUpdateApplyService } from "../features/updates/host/update-apply.js";
import { DESKTOP_RESOURCE_ROOT_MARKER, formatDesktopResourceRootMarker } from "@fleet-console/protocol/desktop";
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
