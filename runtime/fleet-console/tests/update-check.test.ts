import { describe, expect, it } from "vitest";

import { createConsoleUpdateCheckService } from "../src/update-check.js";

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

  it("caches stable update results within the TTL", async () => {
    let clock = 1_000;
    let lookupCount = 0;
    const service = createConsoleUpdateCheckService({
      readRelease: () => ({ channel: "stable", version: "1.0.0", packageRoot: "/console" }),
      fetchLatest: async () => {
        lookupCount += 1;
        return "1.1.0";
      },
      now: () => clock,
      ttlMs: 60_000,
    });

    await expect(service.refresh()).resolves.toEqual({ updateAvailable: true, latestVersion: "1.1.0" });
    clock += 30_000;

    await expect(service.refresh()).resolves.toEqual({ updateAvailable: true, latestVersion: "1.1.0" });
    expect(service.getStatus()).toEqual({ updateAvailable: true, latestVersion: "1.1.0" });
    expect(lookupCount).toBe(1);
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
});
