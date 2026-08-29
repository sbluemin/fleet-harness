// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { shellSurface } from "../client/shell/index.js";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("closing the Shell slot", () => {
  // 셸의 cwd는 첫 기동에 못 박히고 "사용자가 셸을 종료할 때까지" 유지된다. 종료의
  // 유일한 표현이 슬롯 닫기이므로, 호스트의 닫힘 통보가 세션을 끝내지 않으면 그 핀은
  // 영원히 풀리지 않는다 — Theater를 옮겨도 셸은 옛 Theater에 서 있게 된다.
  it("terminates the console-global session so the pinned cwd is released", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    shellSurface.onClose?.({ surfaceId: "shell", instanceId: "shell#1", params: {} });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/plugins/terminal/shell/session");
    expect(init.method).toBe("DELETE");
  });

  it("stays quiet when the console cannot be reached", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("offline"); });
    vi.stubGlobal("fetch", fetchMock);

    expect(() => shellSurface.onClose?.({ surfaceId: "shell", instanceId: "shell#1", params: {} })).not.toThrow();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});
