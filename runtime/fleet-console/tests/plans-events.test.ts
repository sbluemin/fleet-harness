import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type http from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureWorkspaceDirectory } from "@dotobokuri/core-infra/workspace-dir";

import { createPlansRouter } from "../core/host/plans/routes.js";
import { PLANS_WATCH_DEBOUNCE_MS, createPlansWatcherRegistry, type PlansWatcherFactory, type PlansWatcherHandle } from "../core/host/plans/watcher.js";
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
  it("requires the exact Console Origin before validating or subscribing to event requests", async () => {
    const subscribe = vi.fn();
    const resolveTheaterPath = vi.fn((id: string) => id === "known" ? theaterPath : null);
    const eventOrigin = "http://127.0.0.1:4312";
    const denied = createRouteContext({ subscribe, resolveTheaterPath, authorized: true, eventsAuthorized: (req) => req.headers.origin === eventOrigin });

    await denied.router({ req: request("GET", "?theaterId=known"), res: {} as http.ServerResponse, pathname: "/api/v1/plans/events" });
    await denied.router({ req: request("GET", "?theaterId=known", "http://evil.example"), res: {} as http.ServerResponse, pathname: "/api/v1/plans/events" });
    expect(denied.responses).toEqual([{ status: 401, body: { error: "unauthorized" } }, { status: 401, body: { error: "unauthorized" } }]);
    expect(resolveTheaterPath).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();

    const malformed = createRouteContext({ subscribe, resolveTheaterPath, authorized: true, eventsAuthorized: () => true });
    await malformed.router({ req: request("POST", "?theaterId=known", eventOrigin), res: {} as http.ServerResponse, pathname: "/api/v1/plans/events" });
    for (const suffix of ["", "?theaterId=", "?theaterId=known&theaterId=other", "?theaterId=known&extra=value"]) {
      await malformed.router({ req: request("GET", suffix, eventOrigin), res: {} as http.ServerResponse, pathname: "/api/v1/plans/events" });
    }
    await malformed.router({ req: request("GET", "?theaterId=unknown", eventOrigin), res: {} as http.ServerResponse, pathname: "/api/v1/plans/events" });
    expect(malformed.responses).toEqual([
      { status: 405, body: { error: "Method not allowed" } },
      { status: 400, body: { error: "invalid_request" } }, { status: 400, body: { error: "invalid_request" } },
      { status: 400, body: { error: "invalid_request" } }, { status: 400, body: { error: "invalid_request" } },
      { status: 404, body: { error: "theater_not_found" } },
    ]);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("opens an authorized valid Theater signal without serializing watch data", async () => {
    const subscribe = vi.fn();
    const eventOrigin = "http://127.0.0.1:4312";
    const { router, responses } = createRouteContext({ subscribe, resolveTheaterPath: () => theaterPath, authorized: true, eventsAuthorized: (req) => req.headers.origin === eventOrigin });
    const response = {} as http.ServerResponse;

    await router({ req: request("GET", "?theaterId=theater%20one", eventOrigin), res: response, pathname: "/api/v1/plans/events" });

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
    const factory = vi.fn((_path: string, _options: { readonly recursive: boolean }, listener: Parameters<PlansWatcherFactory>[2]) => {
      watcher.listen(listener);
      return watcher;
    });
    const registry = createPlansWatcherRegistry(factory);
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = registry.subscribe("/safe/plans", first, vi.fn());
    const unsubscribeSecond = registry.subscribe("/safe/plans", second, vi.fn());

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
    const factory = vi.fn((_path: string, _options: { readonly recursive: boolean }, listener: Parameters<PlansWatcherFactory>[2]) => {
      const watcher = calls++ === 0 ? firstWatcher : secondWatcher;
      watcher.listen(listener);
      return watcher;
    });
    const registry = createPlansWatcherRegistry(factory);
    const onChange = vi.fn();
    const onClose = vi.fn();
    const unsubscribe = registry.subscribe("/safe/plans", onChange, onClose);

    firstWatcher.change(); firstWatcher.error();
    vi.advanceTimersByTime(PLANS_WATCH_DEBOUNCE_MS);
    expect(onChange).not.toHaveBeenCalled();
    expect(firstWatcher.close).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    unsubscribe();
    expect(firstWatcher.close).toHaveBeenCalledOnce();
    const retry = registry.subscribe("/safe/plans", onChange, vi.fn());
    expect(factory).toHaveBeenCalledTimes(2);
    retry();
    expect(secondWatcher.close).toHaveBeenCalledOnce();
  });

  it("notifies the initial SSE subscriber when watcher creation fails", () => {
    const registry = createPlansWatcherRegistry(() => { throw new Error("watch failed"); });
    const onClose = vi.fn();

    registry.subscribe("/safe/plans", vi.fn(), onClose);

    expect(onClose).toHaveBeenCalledOnce();
  });
});

function createRouteContext({ subscribe, resolveTheaterPath, authorized, eventsAuthorized }: {
  readonly subscribe: (res: http.ServerResponse, watchPath: string) => void;
  readonly resolveTheaterPath: (id: string) => string | null;
  readonly authorized: boolean;
  readonly eventsAuthorized: (req: http.IncomingMessage) => boolean;
}) {
  const responses: JsonResponse[] = [];
  return {
    responses,
    router: createPlansRouter({
      dataDir,
      isAuthorized: () => authorized,
      isEventsAuthorized: eventsAuthorized,
      readJsonBody: async () => null,
      resolveTheaterPath,
      subscribeToChanges: subscribe,
      writeJson: (_res, status, body) => responses.push({ status, body }),
    }),
  };
}

function request(method: string, suffix: string, origin?: string): http.IncomingMessage {
  return { method, url: `/api/v1/plans/events${suffix}`, headers: origin ? { origin } : {} } as http.IncomingMessage;
}

class FakeWatcher implements PlansWatcherHandle {
  readonly close = vi.fn();
  private changeListener: Parameters<PlansWatcherFactory>[2] | null = null;
  private errorListener: ((error: Error) => void) | null = null;

  on(_event: "error", listener: (error: Error) => void): unknown { this.errorListener = listener; return this; }
  listen(listener: Parameters<PlansWatcherFactory>[2]): void { this.changeListener = listener; }
  change(): void { this.changeListener?.("change", "plan.md"); }
  error(): void { this.errorListener?.(new Error("watch failed")); }
}
