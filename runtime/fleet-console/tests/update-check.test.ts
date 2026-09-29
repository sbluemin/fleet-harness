import { describe, expect, it } from "vitest";

import type { ConsoleReleaseManifest } from "@fleet-console/protocol/release";
import type { ConsoleReleaseLookup } from "@fleet-console/updates";

import { createConsoleUpdateCheckService } from "../features/updates/host/update-check.js";

function releaseLookup(version: string): ConsoleReleaseLookup {
  const manifest: ConsoleReleaseManifest = {
    schema: 1,
    package: "@dotobokuri/fleet-console",
    version,
    tag: `v${version}`,
    tarball: { name: `fleet-console-${version}.tgz`, size: 1, sha256: "0".repeat(64) },
  };
  return { ok: true, manifest };
}

const UNREACHABLE: ConsoleReleaseLookup = { ok: false, reason: "unreachable" };

describe("console update check", () => {
  it("skips the release lookup for local console builds", async () => {
    let lookupCount = 0;
    const service = createConsoleUpdateCheckService({
      readRelease: () => ({ channel: "local", version: "1.0.0", packageRoot: "/console" }),
      fetchRelease: async () => {
        lookupCount += 1;
        return releaseLookup("2.0.0");
      },
    });

    await expect(service.refresh()).resolves.toEqual({ updateAvailable: false });
    expect(service.getStatus()).toEqual({ updateAvailable: false });
    expect(lookupCount).toBe(0);
  });

  it("degrades to no update when the release lookup fails", async () => {
    const service = createConsoleUpdateCheckService({
      readRelease: () => ({ channel: "stable", version: "1.0.0", packageRoot: "/console" }),
      fetchRelease: async () => UNREACHABLE,
    });

    await expect(service.refresh()).resolves.toEqual({ updateAvailable: false });
    expect(service.getStatus()).toEqual({ updateAvailable: false });
  });

  it("rejects an explicit check when the release lookup fails", async () => {
    const service = createConsoleUpdateCheckService({
      readRelease: () => ({ channel: "stable", version: "1.0.0", packageRoot: "/console" }),
      fetchRelease: async () => UNREACHABLE,
    });

    // 사용자가 누른 확인은 "모름"을 "최신"으로 바꿔 말하면 안 된다.
    await expect(service.check!()).rejects.toThrow("release lookup failed: unreachable");
  });

  it("keeps the last known update when a later lookup fails", async () => {
    let online = true;
    const service = createConsoleUpdateCheckService({
      readRelease: () => ({ channel: "stable", version: "1.0.0", packageRoot: "/console" }),
      fetchRelease: async () => (online ? releaseLookup("2.0.0") : UNREACHABLE),
    });

    await expect(service.refresh()).resolves.toEqual({ updateAvailable: true, latestVersion: "2.0.0" });
    online = false;
    await expect(service.check!()).rejects.toThrow("release lookup failed");
    // 일시적 장애가 이미 알려진 업데이트를 지우면 안 된다.
    expect(service.getStatus()).toEqual({ updateAvailable: true, latestVersion: "2.0.0" });
  });

  it("requires a shell update for a managed runtime whose Desktop cannot install from Release", async () => {
    const createService = (env: NodeJS.ProcessEnv) =>
      createConsoleUpdateCheckService({
        readRelease: () => ({ channel: "stable", version: "1.0.0", packageRoot: "/desktop/runtime/console" }),
        fetchRelease: async () => releaseLookup("2.0.0"),
        isManagedRuntime: () => true,
        env,
      });

    const oldShell = createService({});
    const newShell = createService({ FLEET_DESKTOP_CONSOLE_SOURCE: "github-release" });

    // 옛 셸은 관리 런타임을 npm에서 다시 깔기 때문에, 제자리 설치 대신 셸 업데이트로 막아야 한다.
    await expect(oldShell.check!()).resolves.toEqual({ updateAvailable: true, latestVersion: "2.0.0", shellUpdateRequired: true });
    await expect(newShell.check!()).resolves.toEqual({ updateAvailable: true, latestVersion: "2.0.0" });
    expect(newShell.latestRelease!()?.version).toBe("2.0.0");
  });
});
