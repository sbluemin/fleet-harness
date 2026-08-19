import { describe, expect, it, vi } from "vitest";

import { createDesktopUpdateSynchronizer, parseDesktopUpdateEvent, parseDesktopUpdateRequest } from "../src/desktop-update-sync.js";

const ORIGIN = "http://127.0.0.1:4000";

function snapshotResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** 스트림은 열리자마자 끝난다 — 이 테스트가 보는 것은 스냅샷 경로다. */
function emptyStream(): Response {
  return new Response(new ReadableStream({ start: (controller) => controller.close() }), { status: 200 });
}

function createFetchStub(snapshot: unknown): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    return url.endsWith("/events") ? emptyStream() : snapshotResponse(snapshot);
  }) as unknown as typeof fetch;
}

describe("desktop update synchronizer", () => {
  it("performs the update the console asked the shell to perform", async () => {
    const applyUpdate = vi.fn();
    const sync = createDesktopUpdateSynchronizer({
      applyUpdate,
      fetch: createFetchStub({ requestedVersion: "1.68.0", requestId: "abc" }),
      setTimeout: (() => 0) as never,
    });

    await sync.start(ORIGIN);

    expect(applyUpdate).toHaveBeenCalledWith("1.68.0");
    sync.stop();
  });

  it("performs one request once, however many times the console repeats it", async () => {
    // 재연결하면 콘솔은 걸려 있던 요청을 다시 들려준다. 그 반복을 두 번의 재시작으로 받아들이면
    // 사용자는 앱이 저 혼자 재시작하는 것을 본다.
    const applyUpdate = vi.fn();
    const fetchStub = createFetchStub({ requestedVersion: "1.68.0", requestId: "abc" });
    const sync = createDesktopUpdateSynchronizer({ applyUpdate, fetch: fetchStub, setTimeout: (() => 0) as never });

    await sync.start(ORIGIN);
    await sync.start(ORIGIN);
    await sync.start(ORIGIN);

    expect(applyUpdate).toHaveBeenCalledTimes(1);
    sync.stop();
  });

  it("does nothing when no update is pending", async () => {
    const applyUpdate = vi.fn();
    const sync = createDesktopUpdateSynchronizer({
      applyUpdate,
      fetch: createFetchStub({ requestedVersion: null, requestId: null }),
      setTimeout: (() => 0) as never,
    });

    await sync.start(ORIGIN);

    expect(applyUpdate).not.toHaveBeenCalled();
    sync.stop();
  });

  it("refuses a payload that does not look like a version and an id", () => {
    expect(parseDesktopUpdateRequest({ requestedVersion: "1.68.0", requestId: "abc" })).toEqual({ requestedVersion: "1.68.0", requestId: "abc" });
    expect(parseDesktopUpdateRequest({ requestedVersion: null, requestId: null })).toEqual({ requestedVersion: null, requestId: null });
    // 셸이 이 값으로 프로세스를 재시작한다 — 모양이 다르면 받지 않는다.
    expect(parseDesktopUpdateRequest({ requestedVersion: "../../etc", requestId: "abc" })).toBeNull();
    expect(parseDesktopUpdateRequest({ requestedVersion: "1.68.0", requestId: "a b" })).toBeNull();
    expect(parseDesktopUpdateRequest({ requestedVersion: "1.68.0" })).toBeNull();
    expect(parseDesktopUpdateRequest(null)).toBeNull();
    expect(parseDesktopUpdateRequest([])).toBeNull();
  });

  it("reads only its own event name off the stream", () => {
    expect(parseDesktopUpdateEvent('event: desktop:update\ndata: {"requestedVersion":"1.68.0","requestId":"abc"}'))
      .toEqual({ requestedVersion: "1.68.0", requestId: "abc" });
    expect(parseDesktopUpdateEvent('event: desktop:theme\ndata: {"requestedVersion":"1.68.0","requestId":"abc"}')).toBeNull();
    expect(parseDesktopUpdateEvent("event: desktop:update")).toBeNull();
  });
});
