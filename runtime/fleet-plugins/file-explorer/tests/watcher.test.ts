import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WatcherFactory } from "../server/watcher.js";
import { createWatcherRegistry } from "../server/watcher.js";

function createNativeWatcherRegistry(factory: WatcherFactory, debounceMs?: number) {
  return createWatcherRegistry(factory, debounceMs, "darwin");
}

describe("createWatcherRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("첫 구독자가 watcher를 생성한다", () => {
    const mockClose = vi.fn();
    const mockFactory: WatcherFactory = vi.fn().mockReturnValue({ close: mockClose, on: vi.fn() });
    const registry = createNativeWatcherRegistry(mockFactory);

    const unsub = registry.subscribe("t1", "/path", () => {}, () => {});
    expect(mockFactory).toHaveBeenCalledOnce();
    expect(mockFactory).toHaveBeenCalledWith("/path", { recursive: true }, expect.any(Function));
    unsub();
  });

  it("마지막 구독자 해제 시 watcher.close()를 호출한다", () => {
    const mockClose = vi.fn();
    const mockFactory: WatcherFactory = vi.fn().mockReturnValue({ close: mockClose, on: vi.fn() });
    const registry = createNativeWatcherRegistry(mockFactory);

    const unsub1 = registry.subscribe("t1", "/path", () => {}, () => {});
    const unsub2 = registry.subscribe("t1", "/path", () => {}, () => {});

    unsub1();
    expect(mockClose).not.toHaveBeenCalled();
    unsub2();
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("Linux에서는 theater 밖으로 해석되는 디렉터리를 감시하지 않는다", async () => {
    const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-file-watch-"));
    const tempRoot = path.join(tempParent, "theater");
    const outsidePath = path.join(tempParent, "outside");
    fs.mkdirSync(tempRoot);
    fs.mkdirSync(outsidePath);
    const mockFactory: WatcherFactory = vi.fn().mockReturnValue({ close: vi.fn(), on: vi.fn() });
    const registry = createWatcherRegistry(mockFactory, 50, "linux");

    try {
      const unsub = registry.subscribe("t1", tempRoot, () => {}, () => {});
      await registry.trackDirectory("t1", tempRoot, "../outside");

      expect(mockFactory).toHaveBeenCalledOnce();
      unsub();
    } finally {
      fs.rmSync(tempParent, { recursive: true, force: true });
    }
  });
});
