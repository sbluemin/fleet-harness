import type http from "node:http";
import type { Duplex } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { UpgradeHandlerContext } from "../core/host/route-registry/registry.js";
import { createUpgradeListener } from "../core/host/server.js";

type UpgradeHandleMock = (ctx: UpgradeHandlerContext) => boolean;

// 업그레이드 거절은 바이트 없이 소켓 파기로만 표현되므로 거절 사유를 응답으로 구분할 수 없다.
// 그래서 "호스트 판정이 레지스트리 위임보다 먼저"라는 순서 자체를 계약으로 고정한다.
describe("websocket upgrade host gate", () => {
  it("destroys the socket without consulting the upgrade registry when the host is rejected", () => {
    const handle = vi.fn<UpgradeHandleMock>(() => true);
    const listener = createUpgradeListener({ isHostAllowed: () => false, upgradeRegistry: { handle } });
    const socket = createSocketStub();

    listener(createUpgradeRequest("/plugins/terminal/ws?ticket=stolen"), socket.duplex, Buffer.alloc(0));

    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(handle).not.toHaveBeenCalled();
  });

  it("delegates to the upgrade registry once the host is accepted", () => {
    const handle = vi.fn<UpgradeHandleMock>(() => true);
    const listener = createUpgradeListener({ isHostAllowed: () => true, upgradeRegistry: { handle } });
    const socket = createSocketStub();
    const req = createUpgradeRequest("/plugins/terminal/ws?ticket=granted");

    listener(req, socket.duplex, Buffer.alloc(0));

    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]![0]).toMatchObject({ pathname: "/plugins/terminal/ws" });
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it("destroys the socket when an accepted host has no matching upgrade handler", () => {
    const handle = vi.fn<UpgradeHandleMock>(() => false);
    const listener = createUpgradeListener({ isHostAllowed: () => true, upgradeRegistry: { handle } });
    const socket = createSocketStub();

    listener(createUpgradeRequest("/nothing-listens-here"), socket.duplex, Buffer.alloc(0));

    expect(handle).toHaveBeenCalledTimes(1);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });
});

function createUpgradeRequest(url: string): http.IncomingMessage {
  return { url, headers: { host: "127.0.0.1:4310" }, rawHeaders: ["Host", "127.0.0.1:4310"] } as unknown as http.IncomingMessage;
}

function createSocketStub(): { readonly duplex: Duplex; readonly destroy: ReturnType<typeof vi.fn> } {
  const destroy = vi.fn();
  return { duplex: { destroy } as unknown as Duplex, destroy };
}
