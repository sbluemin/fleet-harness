import crypto from "node:crypto";
import tls from "node:tls";

import { describe, expect, it, vi } from "vitest";

import { DESKTOP_HOST_TRANSPORT_EVENT, DESKTOP_HOST_TRANSPORT_EVENTS_PATH, DESKTOP_HOST_TRANSPORT_PATH, DESKTOP_HOST_TRANSPORT_RELAY_PATH, type DesktopHostCommand } from "@fleet-console/protocol/desktop";
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

  it("pairs without navigating, activating, or putting the grant on the relay", async () => {
    const target = { hostname: "remote.example", port: 8443, fingerprint: "AB".repeat(32) };
    const origin = "https://remote.example:8443";
    const posts: { url: string; body: string }[] = [];
    const cookies: { name: string; value: string }[] = [];
    const windowCookies: { url: string; name: string; value: string }[] = [];
    let grant: string | null = "grant-secret";
    let handoffs = 0;
    let confirm: () => Promise<void> = async () => undefined;
    let submitted: Response | null = null;
    let confirmThrows = false;
    let confirmStatus = 0;
    let presenceReject = false;
    const rememberWindow = (cookie: { url: string; name: string; value: string }): void => {
      const index = windowCookies.findIndex((entry) => entry.url === cookie.url && entry.name === cookie.name);
      if (index >= 0) windowCookies[index] = cookie;
      else windowCookies.push(cookie);
    };
    const partition = {
      async fetch(url: string, init?: RequestInit) {
        const body = typeof init?.body === "string" ? init.body : "";
        posts.push({ url, body });
        if (url.endsWith("/api/v1/sessions")) {
          if (body.includes('"release"')) return Response.json({ error: "unauthorized" }, { status: 401 });
          if (presenceReject) return Response.json({ error: "unauthorized" }, { status: 401 });
          return Response.json({ capability: "host-session", mode: "observer", access: "full" }, { status: 200 });
        }
        if (body === "{}") {
          const pairing = cookies.find((entry) => entry.name === "fleet_console_pairing_8443" && entry.value.length > 0);
          if (pairing && confirmThrows) throw new Error("reset");
          if (pairing && confirmStatus !== 0) return new Response(null, { status: confirmStatus });
          if (pairing?.value === "stale-secret") return Response.json({ error: "unauthorized" }, { status: 401 });
          if (pairing) return new Response(null, { status: 204 });
          return Response.json({ error: "invalid_join", capability: "pair" }, { status: 400 });
        }
        if (submitted) return submitted;
        return new Response(null, { status: 204, headers: { "set-cookie": "fleet_console_pairing_8443=pairing-secret; HttpOnly; Secure; Path=/" } });
      },
      async readCookies() { return cookies.map((cookie) => ({ ...cookie })); },
      async writeCookie(cookie: { name: string; value: string }) {
        const index = cookies.findIndex((entry) => entry.name === cookie.name);
        if (index >= 0) cookies[index] = { name: cookie.name, value: cookie.value };
        else cookies.push({ name: cookie.name, value: cookie.value });
      },
      async removeCookie(_url: string, name: string) {
        const index = cookies.findIndex((entry) => entry.name === name);
        if (index >= 0) cookies.splice(index, 1);
      },
      pin() { return undefined; },
      clear() { cookies.splice(0, cookies.length); },
    };
    const executor = createHostTransportExecutor({
      confirmIdentity: () => confirm(),
      openPartition: () => partition,
      readWindowCookies: async (url) => windowCookies.filter((cookie) => cookie.url === url).map(({ name, value }) => ({ name, value })),
      writeWindowCookie: async (cookie) => { rememberWindow({ url: cookie.url, name: cookie.name, value: cookie.value }); },
      removeWindowCookie: async (url, name) => {
        const index = windowCookies.findIndex((entry) => entry.url === url && entry.name === name);
        if (index >= 0) windowCookies.splice(index, 1);
      },
      localOrigin: () => "http://127.0.0.1:4010",
      deviceName: "inline-host",
      localFetch: async () => {
        handoffs += 1;
        const token = grant;
        grant = null;
        return Response.json({ origin, hostname: target.hostname, port: target.port, fingerprint: target.fingerprint, token });
      },
    });
    const command = { id: 7, hostKey: "host1", epoch: 1, op: "pair" as const, routeId: "pair", target, params: {} };
    const relay = await executor.execute(command);
    expect(relay).toEqual({ id: 7, capability: "supported", mode: "off", access: null });
    expect(JSON.stringify(relay)).not.toContain("grant-secret");
    expect(posts.map((entry) => entry.url)).toEqual([`${origin}/api/v1/pair`, `${origin}/api/v1/pair`]);
    expect(posts[0]?.body).toBe("{}");
    expect(JSON.parse(posts[1]?.body ?? "{}")).toEqual({ token: "grant-secret", device: "inline-host" });
    expect(posts.every((entry) => !entry.url.includes("/api/v1/join") && !entry.url.includes("/console/") && !entry.url.includes("/api/v1/sessions"))).toBe(true);
    expect(cookies).toEqual([{ name: "fleet_console_pairing_8443", value: "pairing-secret" }]);
    expect(windowCookies.map((cookie) => cookie.name)).toEqual(["fleet_console_pairing_8443"]);
    expect(await executor.execute({ ...command, id: 8 })).toMatchObject({ capability: "supported", mode: "off", access: null });
    expect(handoffs).toBe(1);
    expect(posts).toHaveLength(3);

    cookies.splice(0, cookies.length);
    const kept = windowCookies.findIndex((entry) => entry.url === origin && entry.name === "fleet_console_pairing_8443");
    if (kept >= 0) windowCookies.splice(kept, 1);
    grant = null;
    expect(await executor.execute({ ...command, id: 9 })).toMatchObject({ error: "remote_link_required" });
    expect(posts.at(-1)?.body).toBe("{}");

    cookies.splice(0, cookies.length);
    grant = "other-grant";
    const shifted = await executor.execute({ ...command, id: 10, target: { ...target, fingerprint: "CD".repeat(32) } });
    expect(shifted).toMatchObject({ error: "stale_epoch" });
    expect(posts.some((entry) => entry.body.includes("other-grant"))).toBe(false);

    const before = handoffs;
    confirm = async () => { throw new Error("remote_link_fingerprint_mismatch"); };
    expect(await executor.execute({ ...command, id: 11 })).toMatchObject({ error: "remote_host_fingerprint_mismatch" });
    expect(handoffs).toBe(before);
    confirm = async () => undefined;
    expect(await executor.execute({ ...command, id: 12 }, AbortSignal.abort())).toMatchObject({ error: "remote_host_unavailable" });
    expect(handoffs).toBe(before);
    expect(await executor.execute({ ...command, id: 13, params: { token: "grant-secret" } })).toMatchObject({ error: "route_denied" });

    submitted = new Response(null, { status: 204, headers: { "set-cookie": "fleet_console_session_8443=session-secret; HttpOnly; Secure; Path=/" } });
    cookies.splice(0, cookies.length);
    grant = "session-grant";
    const sessionRelay = await executor.execute({ ...command, id: 14 });
    expect(sessionRelay).toMatchObject({ error: "remote_host_unavailable" });
    expect(windowCookies.some((cookie) => cookie.name.startsWith("fleet_console_session_"))).toBe(false);

    const old = createHostTransportExecutor({
      confirmIdentity: async () => undefined,
      openPartition: () => partition,
      readWindowCookies: async () => [],
      writeWindowCookie: async () => undefined,
    });
    expect(await old.execute({ ...command, id: 15 })).toMatchObject({ capability: "unsupported", error: "host_unsupported" });

    const otherOrigin = "https://remote.example:9443";
    submitted = null;
    cookies.splice(0, cookies.length);
    rememberWindow({ url: origin, name: "fleet_console_pairing_8443", value: "stale-secret" });
    rememberWindow({ url: origin, name: "fleet_console_session_8443", value: "dead-session" });
    rememberWindow({ url: otherOrigin, name: "fleet_console_pairing_9443", value: "other-port" });
    grant = "fresh-grant";
    const recovered = await executor.execute({ ...command, id: 16 });
    expect(recovered).toEqual({ id: 16, capability: "supported", mode: "off", access: null });
    expect(posts.filter((entry) => entry.body.includes("fresh-grant"))).toHaveLength(1);
    expect(posts.some((entry) => entry.url.includes("/api/v1/join") || entry.url.includes("/api/v1/sessions"))).toBe(false);
    expect(cookies.find((entry) => entry.name === "fleet_console_pairing_8443")?.value).toBe("pairing-secret");
    expect(windowCookies.find((entry) => entry.url === origin && entry.name === "fleet_console_pairing_8443")?.value).toBe("pairing-secret");
    expect(windowCookies.find((entry) => entry.url === origin && entry.name === "fleet_console_session_8443")).toBeUndefined();
    expect(windowCookies.find((entry) => entry.url === otherOrigin)?.value).toBe("other-port");

    cookies.splice(0, cookies.length);
    rememberWindow({ url: origin, name: "fleet_console_pairing_8443", value: "stale-secret" });
    grant = null;
    const beforeHandoff = handoffs;
    expect(await executor.execute({ ...command, id: 17 })).toMatchObject({ error: "remote_link_required" });
    expect(handoffs).toBe(beforeHandoff + 1);
    expect(windowCookies.find((entry) => entry.url === origin && entry.name === "fleet_console_pairing_8443")).toBeUndefined();
    expect(windowCookies.find((entry) => entry.url === otherOrigin)?.value).toBe("other-port");

    rememberWindow({ url: origin, name: "fleet_console_pairing_8443", value: "pairing-secret" });
    cookies.splice(0, cookies.length, { name: "fleet_console_pairing_8443", value: "pairing-secret" });
    confirmThrows = true;
    grant = "unused-grant";
    const keptHandoffs = handoffs;
    expect(await executor.execute({ ...command, id: 18 })).toMatchObject({ error: "remote_host_unavailable" });
    expect(handoffs).toBe(keptHandoffs);
    expect(cookies).toEqual([{ name: "fleet_console_pairing_8443", value: "pairing-secret" }]);
    expect(windowCookies.find((entry) => entry.url === origin && entry.name === "fleet_console_pairing_8443")?.value).toBe("pairing-secret");
    confirmThrows = false;

    confirmStatus = 403;
    grant = "unused-too";
    const deniedHandoffs = handoffs;
    const denied = await executor.execute({ ...command, id: 19 });
    expect(denied.error).toBe("remote_host_unavailable");
    expect(handoffs).toBe(deniedHandoffs);
    expect(cookies).toEqual([{ name: "fleet_console_pairing_8443", value: "pairing-secret" }]);
    confirmStatus = 0;

    presenceReject = true;
    expect(await executor.execute({ ...command, id: 20, op: "presence", routeId: "presence", params: { intent: "observe" } })).toMatchObject({ error: "remote_host_not_paired" });
    expect(cookies.find((entry) => entry.name === "fleet_console_pairing_8443")).toBeUndefined();
    expect(windowCookies.find((entry) => entry.url === origin && entry.name === "fleet_console_pairing_8443")).toBeUndefined();
    expect(windowCookies.find((entry) => entry.url === otherOrigin)?.value).toBe("other-port");
    presenceReject = false;
    rememberWindow({ url: origin, name: "fleet_console_pairing_8443", value: "pairing-secret" });
    cookies.push({ name: "fleet_console_pairing_8443", value: "pairing-secret" });
    expect(await executor.execute({ ...command, id: 21, op: "presence", routeId: "presence", params: { intent: "release" } })).toMatchObject({ error: "remote_host_not_paired" });
    expect(cookies.find((entry) => entry.name === "fleet_console_pairing_8443")?.value).toBe("pairing-secret");
    expect(windowCookies.find((entry) => entry.url === origin && entry.name === "fleet_console_pairing_8443")?.value).toBe("pairing-secret");
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
    let eventConnections = 0;
    let endEvents = (): void => undefined;
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
              eventConnections += 1;
              events = controller;
              endEvents = () => { try { controller.close(); } catch { /* already ended */ } };
              push(snapshot(instanceA, 1, 9, "sse"));
              init?.signal?.addEventListener("abort", () => { try { controller.close(); } catch { /* already ended */ } }, { once: true });
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
      endEvents();
      events = null;
      await waitFor(() => eventConnections >= 2 && remoteAborts === 0 && remoteStreams === 1);
      push(snapshot(instanceB, 1, 1, "http"));
      await waitFor(() => remoteGets === 1 && relays.some((relay) => relay.status === 200));
      expect(remoteAborts).toBe(1);
      expect(relays.some((relay) => relay.error === "stale_epoch")).toBe(false);
    } finally {
      transport.stop();
    }
  });

  it("aborts a remote call when its command leaves and retries the relay without running it again", async () => {
    // 공개 snapshot 명령의 수명이다. Console gateway와 붙인 끝단 검증은 아니다.
    const instanceId = "33333333-3333-4333-8333-333333333333";
    const target = { hostname: "remote.example", port: 8443, fingerprint: "AB".repeat(32) };
    const http = (id: number, path: string, method = "GET") => ({
      id, hostKey: "host1", epoch: 1, op: "http" as const, routeId: "host-route", target,
      params: { method, path },
    });
    let generation = 1;
    let commands: DesktopHostCommand[] = [http(1, "/api/v1/agent/sessions/op1/message", "POST")];
    let events: ReadableStreamDefaultController<Uint8Array> | null = null;
    const encoder = new TextEncoder();
    const push = (): void => {
      generation += 1;
      events?.enqueue(encoder.encode(`event: ${DESKTOP_HOST_TRANSPORT_EVENT}\ndata: ${JSON.stringify({ instanceId, generation, commands })}\n\n`));
    };
    let messageFetches = 0;
    let messageAborted = false;
    let operationFetches = 0;
    const relayStatuses: number[] = [];
    let rejectOperations = true;
    const transport = createDesktopHostTransport({
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        if (path === DESKTOP_HOST_TRANSPORT_PATH) return Response.json({ instanceId, generation, commands });
        if (path === DESKTOP_HOST_TRANSPORT_EVENTS_PATH) {
          return new Response(new ReadableStream({
            start(controller) {
              events = controller;
              controller.enqueue(encoder.encode(`event: ${DESKTOP_HOST_TRANSPORT_EVENT}\ndata: ${JSON.stringify({ instanceId, generation, commands })}\n\n`));
              init?.signal?.addEventListener("abort", () => { try { controller.close(); } catch { /* already ended */ } }, { once: true });
            },
          }), { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        if (path === DESKTOP_HOST_TRANSPORT_RELAY_PATH && typeof init?.body === "string") {
          const body = JSON.parse(init.body) as { json?: { operations?: unknown } };
          if (rejectOperations && body.json && "operations" in body.json) {
            rejectOperations = false;
            relayStatuses.push(500);
            return new Response(null, { status: 500 });
          }
          relayStatuses.push(204);
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
      },
      confirmIdentity: async () => undefined,
      openPartition: () => ({
        async fetch(url, init) {
          const path = new URL(url).pathname;
          if (path.endsWith("/message")) {
            messageFetches += 1;
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 3000);
              init?.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
            });
            messageAborted = init?.signal?.aborted === true;
            if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
            return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
          }
          if (path === "/api/v1/operations") {
            operationFetches += 1;
            return new Response(JSON.stringify({ operations: [{ id: "current" }] }), { status: 200, headers: { "content-type": "application/json" } });
          }
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
      await waitFor(() => messageFetches === 1 && events !== null);
      commands = [];
      push();
      await waitFor(() => messageAborted);
      commands = [{ id: 2, hostKey: "host1", epoch: 1, op: "abort", routeId: "abort", target, params: { commandId: 1 } }];
      push();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(messageFetches).toBe(1);
      commands = [http(3, "/api/v1/operations")];
      push();
      await waitFor(() => operationFetches === 1 && relayStatuses.includes(500) && relayStatuses.includes(204));
      expect(operationFetches).toBe(1);
      expect(messageFetches).toBe(1);
    } finally {
      transport.stop();
    }
  });

  it("puts the shell ticket on the remote socket and delivers a send after it opens", async () => {
    const instanceId = "44444444-4444-4444-8444-444444444444";
    const target = { hostname: "remote.example", port: 8443, fingerprint: "AB".repeat(32) };
    const open = { id: 4, hostKey: "host1", epoch: 1, op: "ws-open" as const, routeId: "terminal-ws", target, params: { channel: "terminal", operationId: "op-1" } };
    const send = { id: 5, hostKey: "host1", epoch: 1, op: "ws-send" as const, routeId: "terminal-ws", target, params: { socketId: 4, text: "{\"type\":\"resize\"}" } };
    let generation = 1;
    let commands: Array<typeof open | typeof send> = [open];
    let events: ReadableStreamDefaultController<Uint8Array> | null = null;
    const encoder = new TextEncoder();
    const push = (): void => {
      generation += 1;
      events?.enqueue(encoder.encode(`event: ${DESKTOP_HOST_TRANSPORT_EVENT}\ndata: ${JSON.stringify({ instanceId, generation, commands })}\n\n`));
    };
    let openedPath = "";
    const sent: string[] = [];
    let ticketFetches = 0;
    const transport = createDesktopHostTransport({
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        if (path === DESKTOP_HOST_TRANSPORT_PATH) return Response.json({ instanceId, generation, commands });
        if (path === DESKTOP_HOST_TRANSPORT_EVENTS_PATH) {
          return new Response(new ReadableStream({
            start(controller) {
              events = controller;
              controller.enqueue(encoder.encode(`event: ${DESKTOP_HOST_TRANSPORT_EVENT}\ndata: ${JSON.stringify({ instanceId, generation, commands })}\n\n`));
              init?.signal?.addEventListener("abort", () => { try { controller.close(); } catch { /* already ended */ } }, { once: true });
            },
          }), { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        if (path === DESKTOP_HOST_TRANSPORT_RELAY_PATH) return new Response(null, { status: 204 });
        return new Response(null, { status: 404 });
      },
      confirmIdentity: async () => undefined,
      openPartition: () => ({
        async fetch(url) {
          if (new URL(url).pathname === "/api/v1/agent/ticket") {
            ticketFetches += 1;
            return new Response(JSON.stringify({ ticket: "shell-ticket" }), { status: 200, headers: { "content-type": "application/json" } });
          }
          return new Response("{}", { status: 404 });
        },
        async readCookies() { return []; },
        async writeCookie() { return undefined; },
        pin() { return undefined; },
        clear() { return undefined; },
      }),
      readWindowCookies: async () => [],
      writeWindowCookie: async () => undefined,
      openSocket: async (input) => {
        expect(input.cookie).toBe("");
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (input.signal.aborted) throw new Error("remote_host_unavailable");
        openedPath = input.path;
        let finish = (): void => undefined;
        const closed = new Promise<void>((resolve) => { finish = resolve; });
        return {
          sendText: (text) => { sent.push(text); },
          sendBytes: () => undefined,
          close: () => finish(),
          closed,
        };
      },
    });
    try {
      await transport.start("http://127.0.0.1:9");
      await waitFor(() => openedPath.includes("ticket=shell-ticket") && events !== null);
      expect(JSON.stringify(open.params)).not.toContain("ticket");
      expect(ticketFetches).toBe(1);
      commands = [open, send];
      push();
      await waitFor(() => sent.includes("{\"type\":\"resize\"}"));
      expect(ticketFetches).toBe(1);
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
