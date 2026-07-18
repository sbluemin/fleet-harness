import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type http from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureWorkspaceDirectory } from "@dotobokuri/core-infra/workspace-dir";

import { createPlansRouter } from "../core/host/plans/routes.js";
import { PLANS_WATCH_DEBOUNCE_MS, createPlansWatcherRegistry, type PlansWatcherHandle } from "../core/host/plans/watcher.js";
import { encodeSseData } from "../core/host/sse.js";

interface JsonResponse { readonly status: number; readonly body: unknown; }

let tmpDir: string;
let theaterPath: string;
let dataDir: string;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "plans-events-"));
  theaterPath = path.join(tmpDir, "theater");
  dataDir = path.join(tmpDir, "fleet-data");
  await fs.promises.mkdir(theaterPath);
  await fs.promises.mkdir(path.join(ensureWorkspaceDirectory(dataDir, theaterPath).path, "plans"), { recursive: true });
});

afterEach(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("Plans events route", () => {
  it("rejects wrong methods, unauthorized, malformed, and unknown Theater requests before subscription", async () => {
    const subscribe = vi.fn();
    const resolveTheaterPath = vi.fn((id: string) => id === "known" ? theaterPath : null);
    const denied = createRouteContext({ subscribe, resolveTheaterPath, authorized: false });

    await denied.router({ req: request("POST", "?theaterId=known"), res: {} as http.ServerResponse, pathname: "/api/v1/plans/events" });
    await denied.router({ req: request("GET", "?theaterId=known"), res: {} as http.ServerResponse, pathname: "/api/v1/plans/events" });
    expect(denied.responses).toEqual([{ status: 405, body: { error: "Method not allowed" } }, { status: 401, body: { error: "unauthorized" } }]);
    expect(resolveTheaterPath).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();

    const malformed = createRouteContext({ subscribe, resolveTheaterPath, authorized: true });
    for (const suffix of ["", "?theaterId=", "?theaterId=known&theaterId=other", "?theaterId=known&extra=value"]) {
      await malformed.router({ req: request("GET", suffix), res: {} as http.ServerResponse, pathname: "/api/v1/plans/events" });
    }
    await malformed.router({ req: request("GET", "?theaterId=unknown"), res: {} as http.ServerResponse, pathname: "/api/v1/plans/events" });
    expect(malformed.responses).toEqual([
      { status: 400, body: { error: "invalid_request" } }, { status: 400, body: { error: "invalid_request" } },
      { status: 400, body: { error: "invalid_request" } }, { status: 400, body: { error: "invalid_request" } },
      { status: 404, body: { error: "theater_not_found" } },
    ]);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("opens an authorized valid Theater signal without serializing watch data", async () => {
    const subscribe = vi.fn();
    const { router, responses } = createRouteContext({ subscribe, resolveTheaterPath: () => theaterPath, authorized: true });
    const response = {} as http.ServerResponse;

    await router({ req: request("GET", "?theaterId=theater%20one"), res: response, pathname: "/api/v1/plans/events" });

    expect(responses).toEqual([]);
    expect(subscribe).toHaveBeenCalledOnce();
    expect(subscribe.mock.calls[0]?.[0]).toBe(response);
    expect(encodeSseData("plans-changed", {})).toBe("event: plans-changed\ndata: {}\n\n");
  });
});

describe("Plans watcher registry", () => {
  it("debounces a shared non-recursive watcher and releases it after the last idempotent close", () => {
    vi.useFakeTimers();
    const watcher = new FakeWatcher();
    const factory = vi.fn((_path: string, _options: { readonly recursive: boolean }, listener: () => void) => {
      watcher.listen(listener);
      return watcher;
    });
    const registry = createPlansWatcherRegistry(factory);
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = registry.subscribe("/safe/plans", first);
    const unsubscribeSecond = registry.subscribe("/safe/plans", second);

    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith("/safe/plans", { recursive: false }, expect.any(Function));
    watcher.change(); watcher.change(); watcher.change();
    vi.advanceTimersByTime(PLANS_WATCH_DEBOUNCE_MS - 1);
    expect(first).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    unsubscribeFirst();
    expect(watcher.close).not.toHaveBeenCalled();
    unsubscribeSecond(); unsubscribeSecond();
    expect(watcher.close).toHaveBeenCalledOnce();
  });

  it("contains runtime watcher errors, clears pending signals, and permits a fresh subscription", () => {
    vi.useFakeTimers();
    const firstWatcher = new FakeWatcher();
    const secondWatcher = new FakeWatcher();
    let calls = 0;
    const factory = vi.fn((_path: string, _options: { readonly recursive: boolean }, listener: () => void) => {
      const watcher = calls++ === 0 ? firstWatcher : secondWatcher;
      watcher.listen(listener);
      return watcher;
    });
    const registry = createPlansWatcherRegistry(factory);
    const onChange = vi.fn();
    const unsubscribe = registry.subscribe("/safe/plans", onChange);

    firstWatcher.change(); firstWatcher.error();
    vi.advanceTimersByTime(PLANS_WATCH_DEBOUNCE_MS);
    expect(onChange).not.toHaveBeenCalled();
    expect(firstWatcher.close).toHaveBeenCalledOnce();
    unsubscribe();
    expect(firstWatcher.close).toHaveBeenCalledOnce();
    const retry = registry.subscribe("/safe/plans", onChange);
    expect(factory).toHaveBeenCalledTimes(2);
    retry();
    expect(secondWatcher.close).toHaveBeenCalledOnce();
  });
});

function createRouteContext({ subscribe, resolveTheaterPath, authorized }: {
  readonly subscribe: (res: http.ServerResponse, watchPath: string) => void;
  readonly resolveTheaterPath: (id: string) => string | null;
  readonly authorized: boolean;
}) {
  const responses: JsonResponse[] = [];
  return {
    responses,
    router: createPlansRouter({
      dataDir,
      isAuthorized: () => authorized,
      readJsonBody: async () => null,
      resolveTheaterPath,
      subscribeToChanges: subscribe,
      writeJson: (_res, status, body) => responses.push({ status, body }),
    }),
  };
}

function request(method: string, suffix: string): http.IncomingMessage {
  return { method, url: `/api/v1/plans/events${suffix}` } as http.IncomingMessage;
}

class FakeWatcher implements PlansWatcherHandle {
  readonly close = vi.fn();
  private changeListener: (() => void) | null = null;
  private errorListener: ((error: Error) => void) | null = null;

  on(_event: "error", listener: (error: Error) => void): unknown { this.errorListener = listener; return this; }
  listen(listener: () => void): void { this.changeListener = listener; }
  change(): void { this.changeListener?.(); }
  error(): void { this.errorListener?.(new Error("watch failed")); }
}
