import { describe, expect, it, vi } from "vitest";

import { createConsoleUpdateCheckService } from "../features/updates/host/update-check.js";

describe("console update check", () => {
  it("skips npm lookup for local console builds", async () => {
    let lookupCount = 0;
    const service = createConsoleUpdateCheckService({
      readRelease: () => ({ channel: "local", version: "1.0.0", packageRoot: "/console" }),
      fetchLatest: async () => {
        lookupCount += 1;
        return "2.0.0";
      },
    });

    await expect(service.refresh()).resolves.toEqual({ updateAvailable: false });
    expect(service.getStatus()).toEqual({ updateAvailable: false });
    expect(lookupCount).toBe(0);
  });

  it("degrades to no update when the registry lookup fails", async () => {
    const service = createConsoleUpdateCheckService({
      readRelease: () => ({ channel: "stable", version: "1.0.0", packageRoot: "/console" }),
      fetchLatest: async () => {
        throw new Error("offline");
      },
    });

    await expect(service.refresh()).resolves.toEqual({ updateAvailable: false });
    expect(service.getStatus()).toEqual({ updateAvailable: false });
  });

  it("rejects an explicit check when the registry lookup fails", async () => {
    const service = createConsoleUpdateCheckService({
      readRelease: () => ({ channel: "stable", version: "1.0.0", packageRoot: "/console" }),
      fetchLatest: async () => {
        throw new Error("offline");
      },
    });

    // 사용자가 누른 확인은 "모름"을 "최신"으로 바꿔 말하면 안 된다.
    await expect(service.check!()).rejects.toThrow("offline");
  });

  it("keeps the last known update when a later lookup fails", async () => {
    let online = true;
    const service = createConsoleUpdateCheckService({
      readRelease: () => ({ channel: "stable", version: "1.0.0", packageRoot: "/console" }),
      fetchLatest: async () => {
        if (!online) throw new Error("offline");
        return "2.0.0";
      },
    });

    await expect(service.refresh()).resolves.toEqual({ updateAvailable: true, latestVersion: "2.0.0" });
    online = false;
    await expect(service.check!()).rejects.toThrow("offline");
    // 일시적 장애가 이미 알려진 업데이트를 지우면 안 된다.
    expect(service.getStatus()).toEqual({ updateAvailable: true, latestVersion: "2.0.0" });
  });
});
