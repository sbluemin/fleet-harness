import { describe, expect, it, vi } from "vitest";

import { createConsoleUpdateCheckService } from "../core/host/update-check.js";

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
});
