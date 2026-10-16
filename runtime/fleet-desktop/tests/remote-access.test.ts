import crypto from "node:crypto";
import tls from "node:tls";

import { describe, expect, it, vi } from "vitest";

import { openPinnedWebSocket } from "../src/host-socket.js";
import { createDesktopHostTransport, createHostTransportExecutor } from "../src/host-transport.js";
import {
  CERTIFICATE_ACCEPTED,
  CERTIFICATE_DEFAULT,
  CERTIFICATE_REJECTED,
  confirmRemoteIdentity,
  installRemoteCertificatePins,
  joinRemoteConsole,
  type CertificateVerifyProc,
  type CertificateVerifyRequest,
} from "../src/remote-access.js";

const TOKEN = "y8bWk3Qm5r7uJ2pS4vX9zA1cE6gI0lN8oR2tU5wY7bD";
const FINGERPRINT = "4E65DB042A0B820A0833F016ADAD49B03D7DB5BC43100696AD023A77B647E325";
const OTHER_FINGERPRINT = "0".repeat(64);
const JOIN_URL = "https://192.168.1.20:4310/api/v1/join";

const TEST_CERTIFICATE = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBezCCASKgAwIBAgIBATAKBggqhkjOPQQDAjAdMRswGQYDVQQDDBJmbGVldC1j",
  "b25zb2xlLXRlc3QwHhcNMjYwODA3MTEzMTE4WhcNMzYwODA0MTEzMTE4WjAdMRsw",
  "GQYDVQQDDBJmbGVldC1jb25zb2xlLXRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMB",
  "BwNCAATIGn5NFTF1E2zSev1fJbQh1d7vQX7x2NhChPgNEidaSXCtbbiR5WcOhv9m",
  "tpQCzNOq7NTfL+7X9aKUYd3CG8Afo1MwUTAdBgNVHQ4EFgQUPIXykl6ADdwOykfp",
  "5di45jwyE3gwHwYDVR0jBBgwFoAUPIXykl6ADdwOykfp5di45jwyE3gwDwYDVR0T",
  "AQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBEAiAcerFTzrB6EGtD6SQUbsvvAyTq",
  "YVJb5bEcgcrn6qUm5QIgB2vujyeKrfiyuxsANZse3zlHOstj3TFdaoxovsexxXM=",
  "-----END CERTIFICATE-----",
  "",
].join("\n");

/** 위 인증서와 짝인 개인키. 실제 TLS 핸드셰이크로 신원 확인 경로를 검증하려면 필요하다. */
const TEST_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgfN7fRhySfa0C/HaT",
  "fqgMoLJI4HcIrdRtEqR3r/SlwLWhRANCAATIGn5NFTF1E2zSev1fJbQh1d7vQX7x",
  "2NhChPgNEidaSXCtbbiR5WcOhv9mtpQCzNOq7NTfL+7X9aKUYd3CG8Af",
  "-----END PRIVATE KEY-----",
  "",
].join("\n");

describe("remote certificate pins", () => {
  it("leaves every unpinned host to Chromium and never widens trust", () => {
    const { verify } = pinnedSession();

    expect(verify({ hostname: "example.test", certificate: { data: TEST_CERTIFICATE } })).toBe(CERTIFICATE_DEFAULT);
  });

  it("accepts a pinned host only while the presented certificate matches the link", () => {
    const { pins, verify } = pinnedSession();
    pins.pin("192.168.1.20", FINGERPRINT);

    expect(verify({ hostname: "192.168.1.20", certificate: { data: TEST_CERTIFICATE } })).toBe(CERTIFICATE_ACCEPTED);
    expect(verify({ hostname: "192.168.1.20", certificate: { data: "" } })).toBe(CERTIFICATE_REJECTED);

    pins.pin("192.168.1.20", OTHER_FINGERPRINT);
    expect(verify({ hostname: "192.168.1.20", certificate: { data: TEST_CERTIFICATE } })).toBe(CERTIFICATE_REJECTED);

    pins.unpin("192.168.1.20");
    expect(verify({ hostname: "192.168.1.20", certificate: { data: TEST_CERTIFICATE } })).toBe(CERTIFICATE_DEFAULT);
  });
});

describe("remote console join", () => {
  it("sends the credential in the body, refuses redirects, and keeps it out of the URL", async () => {
    const sessionFetch = vi.fn(async () => new Response(null, { status: 204 }));

    await expect(joinRemoteConsole(sessionFetch, JOIN_URL, TOKEN)).resolves.toBeUndefined();

    const [url, init] = sessionFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(JOIN_URL);
    expect(url).not.toContain(TOKEN);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.body).toBe(JSON.stringify({ token: TOKEN }));
  });

  /**
   * 자격을 다 쓴 뒤 돌아오는 길. 본문에 토큰이 없어야 서버가 페어링 쿠키를 보고 세션을 연다 —
   * 그 요청을 아예 보내지 않으면 회수당한 기기는 새 링크 없이 영영 돌아오지 못한다.
   */
  it("resumes an existing pairing with a body that carries no credential", async () => {
    const sessionFetch = vi.fn(async () => new Response(null, { status: 204 }));

    await joinRemoteConsole(sessionFetch, JOIN_URL, null, "studio-linux");

    const [, init] = sessionFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify({ device: "studio-linux" }));
  });

  /**
   * 409에는 이유가 둘이고 사용자가 할 일이 정반대다 — 기다리거나, 남의 기기를 지우거나.
   * 하나로 뭉개면 상한에 걸린 사용자가 오지 않을 양보를 기다린다.
   */
  it("separates a full seat from a console that can hold no more devices", async () => {
    const held = async (): Promise<Response> =>
      new Response(JSON.stringify({ error: "remote_control_held" }), { status: 409, headers: { "content-type": "application/json" } });
    const full = async (): Promise<Response> =>
      new Response(JSON.stringify({ error: "paired_device_limit" }), { status: 409, headers: { "content-type": "application/json" } });
    const opaque = async (): Promise<Response> => new Response(null, { status: 409 });

    await expect(joinRemoteConsole(held, JOIN_URL, TOKEN)).rejects.toThrow("remote_link_control_held");
    await expect(joinRemoteConsole(full, JOIN_URL, TOKEN)).rejects.toThrow("remote_link_device_limit");
    // 본문을 읽을 수 없으면 지금까지의 뜻으로 되돌린다.
    await expect(joinRemoteConsole(opaque, JOIN_URL, TOKEN)).rejects.toThrow("remote_link_control_held");
  });
});

function pinnedSession(log?: (message: string) => void) {
  let installed: CertificateVerifyProc | null = null;
  const session = { setCertificateVerifyProc: (proc: CertificateVerifyProc | null) => { installed = proc; } };
  const pins = installRemoteCertificatePins(session, log);
  const verify = (request: CertificateVerifyRequest): number => {
    let result = Number.NaN;
    installed?.(request, (value) => { result = value; });
    return result;
  };
  return { pins, verify };
}

describe("remote identity confirmation", () => {
  it("accepts a server whose live certificate matches the link", async () => {
    const server = await startTlsServer();
    try {
      await expect(confirmRemoteIdentity("127.0.0.1", server.port, server.fingerprint, 2000)).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("names a mismatch as its own failure so it never reaches the browser", async () => {
    const server = await startTlsServer();
    try {
      await expect(confirmRemoteIdentity("127.0.0.1", server.port, OTHER_FINGERPRINT, 2000)).rejects.toThrow("remote_link_fingerprint_mismatch");
    } finally {
      await server.close();
    }
  });
});

async function startTlsServer(): Promise<{ port: number; fingerprint: string; close: () => Promise<void> }> {
  const server = tls.createServer({ cert: TEST_CERTIFICATE, key: TEST_KEY }, (socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return {
    port: address.port,
    fingerprint: FINGERPRINT,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

describe("host partition transport", () => {
  it("treats a remote without the session capability as unsupported and does not join", async () => {
    const calls: string[] = [];
    const executor = createHostTransportExecutor({
      confirmIdentity: async () => undefined,
      openPartition: () => ({
        fetch: async (url) => {
          calls.push(url);
          return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
        },
        readCookies: async () => [],
        writeCookie: async () => undefined,
        pin: () => undefined,
        clear: () => undefined,
      }),
      readWindowCookies: async () => [],
      writeWindowCookie: async () => undefined,
    });
    const relay = await executor.execute({
      id: 1,
      hostKey: "host1",
      epoch: 1,
      op: "presence",
      routeId: "presence",
      target: { hostname: "remote.example", port: 8443, fingerprint: "AB".repeat(32) },
      params: { intent: "observe" },
    });
    expect(relay).toMatchObject({ capability: "unsupported", error: "host_unsupported" });
    expect(calls).toEqual(["https://remote.example:8443/api/v1/sessions"]);
  });

  it("does not promote a session response that omits the capability", async () => {
    const executor = createHostTransportExecutor({
      confirmIdentity: async () => undefined,
      openPartition: () => ({
        fetch: async () => new Response(JSON.stringify({ mode: "controller", access: "full" }), { status: 200, headers: { "content-type": "application/json" } }),
        readCookies: async () => [],
        writeCookie: async () => undefined,
        pin: () => undefined,
        clear: () => undefined,
      }),
      readWindowCookies: async () => [],
      writeWindowCookie: async () => undefined,
    });
    const relay = await executor.execute({
      id: 2,
      hostKey: "host1",
      epoch: 1,
      op: "presence",
      routeId: "presence",
      target: { hostname: "remote.example", port: 8443, fingerprint: "AB".repeat(32) },
      params: { intent: "activate" },
    });
    expect(relay.mode).toBeUndefined();
    expect(relay).toMatchObject({ capability: "unsupported", error: "host_unsupported" });
  });
});

describe("host transport streams", () => {
  const target = { hostname: "remote.example", port: 8443, fingerprint: "AB".repeat(32) };
  const partition = {
    async fetch(url: string) {
      if (url.endsWith("/api/v1/operations/events")) return new Response("event: operation:changed\n\ndata: {}\n\n", { status: 200 });
      return new Response("no", { status: 404 });
    },
    async readCookies() { return []; },
    async writeCookie() { return undefined; },
    pin() { return undefined; },
    clear() { return undefined; },
  };

  it("relays the current epoch's event stream and rejects an older command", async () => {
    const frames: { text?: string; error?: string; end?: boolean }[] = [];
    const executor = createHostTransportExecutor({
      confirmIdentity: async () => undefined,
      openPartition: () => partition,
      readWindowCookies: async () => [],
      writeWindowCookie: async () => undefined,
    });
    await executor.run({
      id: 4, hostKey: "host1", epoch: 2, op: "sse", routeId: "operation-events", target, params: { path: "/api/v1/operations/events" },
    }, async (relay) => { frames.push(relay); });
    expect(frames.some((frame) => frame.text?.includes("operation:changed"))).toBe(true);
    expect(frames.at(-1)?.end).toBe(true);
    await expect(executor.execute({
      id: 5, hostKey: "host1", epoch: 1, op: "http", routeId: "theaters", target, params: { method: "GET", path: "/api/v1/theaters" },
    })).resolves.toMatchObject({ error: "stale_epoch" });
  });
});

describe("pinned remote sockets", () => {
  const ticket = "ticket-must-not-leave";
  const cookie = "fleet_console_session_8443=cookie-must-not-leave";

  it("does not write the ticket or cookie when the live certificate pin does not match", async () => {
    const received: Buffer[] = [];
    const server = await listenTls((socket) => {
      socket.on("data", (chunk: Buffer) => received.push(chunk));
    });
    try {
      await expect(openPinnedWebSocket({
        hostname: "127.0.0.1",
        port: server.port,
        path: `/api/v1/terminal/ws?ticket=${ticket}`,
        fingerprint: OTHER_FINGERPRINT,
        cookie,
        signal: AbortSignal.timeout(2000),
        onText: () => undefined,
        onBytes: () => undefined,
      })).rejects.toThrow("remote_host_fingerprint_mismatch");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const wire = Buffer.concat(received).toString("utf8");
      expect(wire).not.toContain(ticket);
      expect(wire).not.toContain(cookie);
      expect(wire).not.toContain("Sec-WebSocket-Key");
    } finally {
      await server.close();
    }
  });

  it("accepts only the matching Sec-WebSocket-Accept before delivering frames", async () => {
    const texts: string[] = [];
    const good = await listenTls((socket) => {
      socket.once("data", (chunk: Buffer) => {
        const key = /Sec-WebSocket-Key: (\S+)/u.exec(chunk.toString("latin1"))?.[1] ?? "";
        const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        socket.write(Buffer.from([0x81, 0x04, 0x70, 0x69, 0x6e, 0x67]));
      });
    });
    try {
      const opened = await openPinnedWebSocket({
        hostname: "127.0.0.1", port: good.port, path: "/api/v1/terminal/ws?ticket=kept-in-shell", fingerprint: FINGERPRINT, cookie: "", signal: AbortSignal.timeout(2000),
        onText: (text) => { texts.push(text); },
        onBytes: () => undefined,
      });
      await waitFor(() => texts.includes("ping"));
      opened.close();
    } finally {
      await good.close();
    }

    const bad = await listenTls((socket) => {
      socket.once("data", () => {
        socket.write("HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: AAAA\r\n\r\n");
        socket.write(Buffer.from([0x81, 0x04, 0x70, 0x69, 0x6e, 0x67]));
      });
    });
    const leaked: string[] = [];
    try {
      await expect(openPinnedWebSocket({
        hostname: "127.0.0.1", port: bad.port, path: "/api/v1/terminal/ws?ticket=kept-in-shell", fingerprint: FINGERPRINT, cookie: "", signal: AbortSignal.timeout(2000),
        onText: (text) => { leaked.push(text); },
        onBytes: () => undefined,
      })).rejects.toThrow("remote_host_unavailable");
      expect(leaked).toEqual([]);
    } finally {
      await bad.close();
    }
  });
});

describe("desktop host transport lifetime", () => {
  it("keeps a live stream across the same console instance and accepts restarted ids", async () => {
    const target = { hostname: "remote.example", port: 8443, fingerprint: "AB".repeat(32) };
    const instanceA = "11111111-1111-4111-8111-111111111111";
    const instanceB = "22222222-2222-4222-8222-222222222222";
    const command = (epoch: number, op: "sse" | "http") => ({
      id: 1, hostKey: "host1", epoch, op, routeId: op === "sse" ? "operation-events" : "theaters", target,
      params: op === "sse" ? { path: "/api/v1/operations/events" } : { method: "GET", path: "/api/v1/theaters" },
    });
    const snapshot = (instanceId: string, generation: number, epoch: number, op: "sse" | "http") => ({
      instanceId, generation, commands: [command(epoch, op)],
    });
    let events: ReadableStreamDefaultController<Uint8Array> | null = null;
    const encoder = new TextEncoder();
    const relays: { error?: string; status?: number }[] = [];
    let remoteStreams = 0;
    let remoteAborts = 0;
    let remoteGets = 0;
    const push = (value: unknown): void => {
      events?.enqueue(encoder.encode(`event: desktop:host-transport\ndata: ${JSON.stringify(value)}\n\n`));
    };
    const transport = createDesktopHostTransport({
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        if (path === "/api/v1/desktop/host-transport") return Response.json(snapshot(instanceA, 1, 9, "sse"));
        if (path === "/api/v1/desktop/host-transport/events") {
          return new Response(new ReadableStream({
            start(controller) {
              events = controller;
              push(snapshot(instanceA, 1, 9, "sse"));
              init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
            },
          }), { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        if (path === "/api/v1/desktop/host-transport/relay" && init?.body) relays.push(JSON.parse(String(init.body)) as { error?: string; status?: number });
        return new Response(null, { status: 204 });
      },
      confirmIdentity: async () => undefined,
      openPartition: () => ({
        async fetch(url, init) {
          if (url.endsWith("/api/v1/operations/events")) {
            remoteStreams += 1;
            return new Response(new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener("abort", () => {
                  remoteAborts += 1;
                  controller.error(new Error("aborted"));
                }, { once: true });
              },
            }), { status: 200 });
          }
          remoteGets += 1;
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
        async readCookies() { return []; },
        async writeCookie() { return undefined; },
        pin() { return undefined; },
        clear() { return undefined; },
      }),
      readWindowCookies: async () => [],
      writeWindowCookie: async () => undefined,
    });
    try {
      await transport.start("http://127.0.0.1:9");
      await waitFor(() => remoteStreams === 1 && events !== null);
      push(snapshot(instanceA, 2, 9, "sse"));
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(remoteAborts).toBe(0);
      expect(remoteStreams).toBe(1);
      push(snapshot(instanceB, 1, 1, "http"));
      await waitFor(() => remoteGets === 1 && relays.some((relay) => relay.status === 200));
      expect(remoteAborts).toBe(1);
      expect(relays.some((relay) => relay.error === "stale_epoch")).toBe(false);
    } finally {
      transport.stop();
    }
  });
});

function waitFor(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (ready()) { resolve(); return; }
      if (Date.now() > deadline) { reject(new Error("timed out")); return; }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function listenTls(onSocket: (socket: tls.TLSSocket) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<tls.TLSSocket>();
  const server = tls.createServer({ cert: TEST_CERTIFICATE, key: TEST_KEY }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => { sockets.delete(socket); });
    onSocket(socket);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no address");
      resolve({
        port: address.port,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}
