import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  createFramer,
  createJsonRpcErrorResponse,
  createJsonRpcNotification,
  createJsonRpcRequest,
  createJsonRpcResponse,
  isNotification,
  isRequest,
  isResponse,
  sendMessage,
} from "../../src/grand-fleet/ipc/protocol.js";

describe("grand fleet IPC protocol", () => {
  it("creates and classifies JSON-RPC messages", () => {
    const request = createJsonRpcRequest("fleet/ping", { ok: true }, "1");
    const notification = createJsonRpcNotification("fleet/ready", { id: "fleet-1" });
    const response = createJsonRpcResponse("1", { pong: true });
    const error = createJsonRpcErrorResponse("2", -32603, "failed", { code: "E_FAIL" });

    expect(isRequest(request)).toBe(true);
    expect(isNotification(notification)).toBe(true);
    expect(isResponse(response)).toBe(true);
    expect(isResponse(error)).toBe(true);
  });

  it("frames ndJSON messages and reports parse errors", () => {
    const socket = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn> };
    socket.write = vi.fn();
    const onMessage = vi.fn();
    const onError = vi.fn();

    createFramer(socket as never, onMessage, onError);
    socket.emit("data", Buffer.from('{"jsonrpc":"2.0","method":"fleet/ready","params":{}}\nnot-json\n'));
    sendMessage(socket as never, createJsonRpcNotification("fleet/ready", {}));

    expect(onMessage).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      method: "fleet/ready",
      params: {},
    });
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(socket.write).toHaveBeenCalledWith(
      JSON.stringify(createJsonRpcNotification("fleet/ready", {})) + "\n",
      "utf-8",
    );
  });
});
