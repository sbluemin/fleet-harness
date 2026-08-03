import { afterEach, describe, expect, it, vi } from "vitest";

import { createClientCapabilities } from "@fleet-console/sdk/plugin/browser";
import { buildTerminalWsUrl, createTerminalConnection, type WebSocketLike } from "../../fleet-plugins/terminal/client/shared/terminal-connection.js";

class FakeWebSocket implements WebSocketLike {
  binaryType: BinaryType = "arraybuffer";
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<ArrayBuffer | string>) => void) | null = null;
  onclose: ((event: { readonly code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  readonly sent: Array<string | Uint8Array> = [];

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.({ code: 1000 });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("client plugin host contract", () => {
  it("limits terminal tickets to ticket and ttl", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      ticket: "shell-ticket",
      ttlMs: 1000,
      providerSessionId: "hidden",
      transcriptPath: "/tmp/hidden",
    })));

    await expect(createClientCapabilities().terminal.requestTicket("terminal", "/shell/ticket", "op_1")).resolves.toEqual({
      ticket: "shell-ticket",
      ttlMs: 1000,
    });
    expect(fetchMock).toHaveBeenCalledWith("/plugins/terminal/shell/ticket", expect.objectContaining({
      body: JSON.stringify({ operationId: "op_1" }),
      method: "POST",
    }));
  });

  it("uses plugin-scoped terminal ticket and websocket paths", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      ticket: "one-shot",
      ttlMs: 1000,
    })));
    const socket = new FakeWebSocket();
    let attachedUrl = "";
    const connection = createTerminalConnection({
      operationId: "op_shell",
      terminal: {
        onData: () => ({ dispose: () => undefined }),
        write: () => undefined,
        drain: (callback) => callback(),
      },
      ticketPath: "/plugins/terminal/shell/ticket",
      wsPath: `${"/plugins/terminal"}/ws`,
      location: { host: "127.0.0.1:4411", protocol: "http:" },
      webSocketFactory: (url) => {
        attachedUrl = url;
        queueMicrotask(() => socket.onopen?.());
        return socket;
      },
    });

    connection.start();
    await vi.waitUntil(() => attachedUrl.length > 0);
    connection.dispose();

    expect(fetchMock).toHaveBeenCalledWith("/plugins/terminal/shell/ticket", expect.objectContaining({
      body: JSON.stringify({ operationId: "op_shell" }),
      method: "POST",
    }));
    expect(attachedUrl).toBe(`ws://127.0.0.1:4411${"/plugins/terminal"}/ws?ticket=one-shot`);
  });

  it("stops reconnecting when the terminal server rejects attach as unavailable", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      ticket: "one-shot",
      ttlMs: 1000,
    })));
    const statuses: string[] = [];
    let socketCount = 0;
    const connection = createTerminalConnection({
      operationId: "op_shell",
      terminal: {
        onData: () => ({ dispose: () => undefined }),
        write: () => undefined,
        drain: (callback) => callback(),
      },
      ticketPath: "/plugins/terminal/shell/ticket",
      wsPath: `${"/plugins/terminal"}/ws`,
      location: { host: "127.0.0.1:4411", protocol: "http:" },
      webSocketFactory: () => {
        socketCount += 1;
        const socket = new FakeWebSocket();
        queueMicrotask(() => {
          socket.onopen?.();
          socket.onclose?.({ code: 1013 });
        });
        return socket;
      },
      onStatus: (status, message) => statuses.push(message ? `${status}:${message}` : status),
    });

    connection.start();
    await vi.waitUntil(() => statuses.includes("closed:terminal_unavailable"));

    expect(socketCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    connection.dispose();
  });

  it("builds websocket URLs without shell-specific branching", () => {
    expect(buildTerminalWsUrl("abc 123", { host: "localhost:9999", protocol: "https:" }, "/plugins/custom/ws")).toBe(
      "wss://localhost:9999/plugins/custom/ws?ticket=abc%20123",
    );
  });
});
