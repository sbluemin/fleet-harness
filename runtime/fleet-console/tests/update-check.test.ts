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

  it("never contacts npm for desktop builds", async () => {
    const fetchLatest = vi.fn(async () => "2.0.0");
    const service = createConsoleUpdateCheckService({
      readRelease: () => ({ channel: "desktop", version: "1.0.0", packageRoot: "/console" }),
      fetchLatest,
    });

    await expect(service.refresh()).resolves.toEqual({ updateAvailable: false });
    expect(fetchLatest).not.toHaveBeenCalled();
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

  it("force refresh bypasses a live TTL cache", async () => {
    let lookupCount = 0;
    const service = createConsoleUpdateCheckService({
      readRelease: () => ({ channel: "stable", version: "1.0.0", packageRoot: "/console" }),
      fetchLatest: async () => {
        lookupCount += 1;
        return lookupCount === 1 ? "1.1.0" : "1.2.0";
      },
      now: () => 1_000,
      ttlMs: 60_000,
    });

    await expect(service.refresh()).resolves.toEqual({ updateAvailable: true, latestVersion: "1.1.0" });
    await expect(service.refresh({ force: true })).resolves.toEqual({ updateAvailable: true, latestVersion: "1.2.0" });
    expect(lookupCount).toBe(2);
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

  it("retries a registry failure after the short error TTL", async () => {
    let clock = 1_000;
    let lookupCount = 0;
    const service = createConsoleUpdateCheckService({
      readRelease: () => ({ channel: "stable", version: "1.0.0", packageRoot: "/console" }),
      fetchLatest: async () => {
        lookupCount += 1;
        throw new Error("offline");
      },
      now: () => clock,
      ttlMs: 60_000,
      errorTtlMs: 5_000,
    });

    await service.refresh();
    clock += 4_999;
    await service.refresh();
    expect(lookupCount).toBe(1);

    clock += 1;
    await service.refresh();
    expect(lookupCount).toBe(2);
  });

  it("treats an undefined registry lookup as a failure with the short error TTL", async () => {
    let clock = 1_000;
    let lookupCount = 0;
    const service = createConsoleUpdateCheckService({
      readRelease: () => ({ channel: "stable", version: "1.0.0", packageRoot: "/console" }),
      // 실 fetchLatestVersion은 타임아웃·비정상 응답에서 throw 없이 undefined를 resolve한다.
      fetchLatest: async () => {
        lookupCount += 1;
        return undefined;
      },
      now: () => clock,
      ttlMs: 60_000,
      errorTtlMs: 5_000,
    });

    await expect(service.refresh()).resolves.toEqual({ updateAvailable: false });
    clock += 4_999;
    await service.refresh();
    expect(lookupCount).toBe(1);

    clock += 1;
    await service.refresh();
    expect(lookupCount).toBe(2);
  });

  it("periodically forces a recheck and releases its unref timer on stop", async () => {
    let scheduled: (() => void) | null = null;
    let lookupCount = 0;
    const unref = vi.fn();
    const clearInterval = vi.fn();
    const service = createConsoleUpdateCheckService({
      readRelease: () => ({ channel: "stable", version: "1.0.0", packageRoot: "/console" }),
      fetchLatest: async () => {
        lookupCount += 1;
        return "1.1.0";
      },
      setInterval: (callback) => {
        scheduled = callback;
        return { unref };
      },
      clearInterval,
    });

    await service.refresh();
    service.start?.();
    service.start?.();
    const triggerScheduledCheck = scheduled ?? (() => {
      throw new Error("periodic check was not scheduled");
    });
    triggerScheduledCheck();
    await vi.waitFor(() => expect(lookupCount).toBe(2));

    expect(unref).toHaveBeenCalledOnce();
    service.stop?.();
    expect(clearInterval).toHaveBeenCalledOnce();
  });

  it("notifies when an update becomes available or its latest version changes", async () => {
    let lookupCount = 0;
    const listener = vi.fn();
    const service = createConsoleUpdateCheckService({
      readRelease: () => ({ channel: "stable", version: "1.0.0", packageRoot: "/console" }),
      fetchLatest: async () => {
        lookupCount += 1;
        return lookupCount === 1 ? "1.1.0" : "1.2.0";
      },
    });
    service.onChange?.(listener);

    await service.refresh();
    await service.refresh({ force: true });

    expect(listener).toHaveBeenNthCalledWith(1, { updateAvailable: true, latestVersion: "1.1.0" });
    expect(listener).toHaveBeenNthCalledWith(2, { updateAvailable: true, latestVersion: "1.2.0" });
  });
});
