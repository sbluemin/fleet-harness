import crypto from "node:crypto";
import tls from "node:tls";

import { describe, expect, it, vi } from "vitest";

import { DESKTOP_HOST_TRANSPORT_EVENT, DESKTOP_HOST_TRANSPORT_EVENTS_PATH, DESKTOP_HOST_TRANSPORT_PATH, DESKTOP_HOST_TRANSPORT_RELAY_PATH, type DesktopHostCommand } from "@fleet-console/protocol/desktop";
import { HOST_RESOURCE_MAX_BYTES } from "@fleet-console/protocol/remote/host-transport";
import { openPinnedWebSocket } from "../src/host-socket.js";
import { createCookieOrder } from "../src/cookie-order.js";
import { createHostPartitionAdapter } from "../src/host-partition-adapter.js";
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
      cookieOrder: createCookieOrder(),
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
      cookieOrder: createCookieOrder(),
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
    let plainUnauthorized = false;
    let holdSession = false;
    const sessionGate: { release: ((response: Response) => void) | null; held: (() => void) | null } = { release: null, held: null };
    let holdGrantBody: string | null = null;
    const grantGate: { release: ((response: Response) => void) | null; held: (() => void) | null } = { release: null, held: null };
    let grantCookie = "pairing-secret";
    let pauseForgetRead = false;
    let pauseNextRead = false;
    const readGate: { resume: (() => void) | null; held: (() => void) | null } = { resume: null, held: null };
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
          if (holdSession) {
            holdSession = false;
            sessionGate.held?.();
            return new Promise<Response>((resolve) => { sessionGate.release = resolve; });
          }
          if (body.includes('"release"')) return Response.json({ error: "unauthorized" }, { status: 401 });
          if (presenceReject) {
            if (pauseForgetRead) pauseNextRead = true;
            return Response.json({ error: "unauthorized" }, { status: 401 });
          }
          return Response.json({ capability: "host-session", mode: "observer", access: "full" }, { status: 200 });
        }
        if (body === "{}") {
          if (plainUnauthorized) return Response.json({ error: "unauthorized" }, { status: 401 });
          const pairing = cookies.find((entry) => entry.name === "fleet_console_pairing_8443" && entry.value.length > 0);
          if (pairing && confirmThrows) throw new Error("reset");
          if (pairing && confirmStatus !== 0) return new Response(null, { status: confirmStatus });
          if (pairing?.value === "stale-secret") return Response.json({ error: "unauthorized", capability: "pair" }, { status: 401 });
          if (pairing) return new Response(null, { status: 204 });
          return Response.json({ error: "invalid_join", capability: "pair" }, { status: 400 });
        }
        if (holdGrantBody && body.includes(holdGrantBody)) {
          holdGrantBody = null;
          grantGate.held?.();
          return new Promise<Response>((resolve) => { grantGate.release = resolve; });
        }
        if (submitted) return submitted;
        return new Response(null, { status: 204, headers: { "set-cookie": `fleet_console_pairing_8443=${grantCookie}; HttpOnly; Secure; Path=/` } });
      },
      async readCookies() {
        if (pauseNextRead) {
          pauseNextRead = false;
          readGate.held?.();
          await new Promise<void>((resolve) => { readGate.resume = resolve; });
        }
        return cookies.map((cookie) => ({ ...cookie }));
      },
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
      cookieOrder: createCookieOrder(),
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
      cookieOrder: createCookieOrder(),
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

    plainUnauthorized = true;
    cookies.splice(0, cookies.length, { name: "fleet_console_pairing_8443", value: "stale-secret" });
    rememberWindow({ url: origin, name: "fleet_console_pairing_8443", value: "stale-secret" });
    grant = "old-server-grant";
    const oldServerHandoffs = handoffs;
    expect(await executor.execute({ ...command, id: 22 })).toMatchObject({ capability: "unsupported", error: "host_unsupported" });
    expect(handoffs).toBe(oldServerHandoffs);
    expect(posts.some((entry) => entry.body.includes("old-server-grant"))).toBe(false);
    expect(cookies.find((entry) => entry.name === "fleet_console_pairing_8443")?.value).toBe("stale-secret");
    expect(windowCookies.find((entry) => entry.url === origin && entry.name === "fleet_console_pairing_8443")?.value).toBe("stale-secret");
    expect(windowCookies.find((entry) => entry.url === otherOrigin)?.value).toBe("other-port");
    plainUnauthorized = false;

    const held = new Promise<void>((resolve) => { sessionGate.held = resolve; });
    holdSession = true;
    cookies.splice(0, cookies.length, { name: "fleet_console_pairing_8443", value: "stale-secret" });
    rememberWindow({ url: origin, name: "fleet_console_pairing_8443", value: "stale-secret" });
    const observeAbort = new AbortController();
    const oldObserve = executor.execute({ ...command, id: 23, op: "presence", routeId: "presence", params: { intent: "observe" } }, observeAbort.signal);
    await held;
    grant = "fresh-grant";
    const pairsBefore = posts.filter((entry) => entry.url.endsWith("/api/v1/pair")).length;
    const replacing = executor.execute({ ...command, id: 24 });
    // 쿠키를 싣는 이전 요청이 응답을 쥐고 있는 동안 같은 origin의 새 pair는 요청을 보내지 않는다.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(posts.filter((entry) => entry.url.endsWith("/api/v1/pair")).length).toBe(pairsBefore);
    sessionGate.release?.(Response.json({ error: "unauthorized" }, { status: 401 }));
    observeAbort.abort();
    expect(await oldObserve).toMatchObject({ error: "remote_host_not_paired" });
    const replaced = await replacing;
    expect(replaced).toEqual({ id: 24, capability: "supported", mode: "off", access: null });
    expect(windowCookies.find((entry) => entry.url === origin && entry.name === "fleet_console_pairing_8443")?.value).toBe("pairing-secret");
    expect(cookies.find((entry) => entry.name === "fleet_console_pairing_8443")?.value).toBe("pairing-secret");
    expect(windowCookies.find((entry) => entry.url === origin && entry.name === "fleet_console_pairing_8443")?.value).toBe("pairing-secret");
    expect(windowCookies.find((entry) => entry.url === otherOrigin)?.value).toBe("other-port");
    expect(posts.some((entry) => entry.url.includes("/api/v1/join"))).toBe(false);

    const heldAgain = new Promise<void>((resolve) => { sessionGate.held = resolve; });
    holdSession = true;
    cookies.splice(0, cookies.length, { name: "fleet_console_pairing_8443", value: "pairing-secret" });
    rememberWindow({ url: origin, name: "fleet_console_pairing_8443", value: "pairing-secret" });
    const sameValue = executor.execute({ ...command, id: 25, op: "presence", routeId: "presence", params: { intent: "observe" } });
    await heldAgain;
    sessionGate.release?.(Response.json({ error: "unauthorized" }, { status: 401 }));
    expect(await sameValue).toMatchObject({ error: "remote_host_not_paired" });
    expect(cookies.find((entry) => entry.name === "fleet_console_pairing_8443")).toBeUndefined();
    expect(windowCookies.find((entry) => entry.url === origin && entry.name === "fleet_console_pairing_8443")).toBeUndefined();
    expect(windowCookies.find((entry) => entry.url === otherOrigin)?.value).toBe("other-port");

    const heldAbort = new Promise<void>((resolve) => { sessionGate.held = resolve; });
    holdSession = true;
    cookies.push({ name: "fleet_console_pairing_8443", value: "pairing-secret" });
    rememberWindow({ url: origin, name: "fleet_console_pairing_8443", value: "pairing-secret" });
    const abortSame = new AbortController();
    const abortedObserve = executor.execute({ ...command, id: 26, op: "presence", routeId: "presence", params: { intent: "observe" } }, abortSame.signal);
    await heldAbort;
    abortSame.abort();
    sessionGate.release?.(Response.json({ error: "unauthorized" }, { status: 401 }));
    expect(await abortedObserve).toMatchObject({ error: "remote_host_not_paired" });
    expect(cookies.find((entry) => entry.name === "fleet_console_pairing_8443")?.value).toBe("pairing-secret");
    expect(windowCookies.find((entry) => entry.url === origin && entry.name === "fleet_console_pairing_8443")?.value).toBe("pairing-secret");

    cookies.splice(0, cookies.length, { name: "fleet_console_pairing_8443", value: "stale-secret" });
    rememberWindow({ url: origin, name: "fleet_console_pairing_8443", value: "stale-secret" });
    presenceReject = true;
    pauseForgetRead = true;
    const readHeld = new Promise<void>((resolve) => { readGate.held = resolve; });
    const readAbort = new AbortController();
    const reading = executor.execute({ ...command, id: 29, op: "presence", routeId: "presence", params: { intent: "observe" } }, readAbort.signal);
    await readHeld;
    readAbort.abort();
    readGate.resume?.();
    await reading;
    expect(cookies.find((entry) => entry.name === "fleet_console_pairing_8443")?.value).toBe("stale-secret");
    expect(windowCookies.find((entry) => entry.url === origin && entry.name === "fleet_console_pairing_8443")?.value).toBe("stale-secret");
    expect(windowCookies.find((entry) => entry.url === otherOrigin)?.value).toBe("other-port");

    cookies.splice(0, cookies.length);
    windowCookies.splice(0, windowCookies.length, { url: otherOrigin, name: "fleet_console_pairing_9443", value: "other-port" });
    grant = "older-grant";
    grantCookie = "newer-fixture";
    holdGrantBody = "older-grant";
    const grantHeld = new Promise<void>((resolve) => { grantGate.held = resolve; });
    const lateAbort = new AbortController();
    const lateGrant = executor.execute({ ...command, id: 27 }, lateAbort.signal);
    await grantHeld;
    grant = "newer-grant";
    const newerRunning = executor.execute({ ...command, id: 28 });
    lateAbort.abort();
    grantGate.release?.(new Response(null, { status: 204, headers: { "set-cookie": "fleet_console_pairing_8443=older-fixture; HttpOnly; Secure; Path=/" } }));
    await lateGrant;
    const newer = await newerRunning;
    expect(newer).toEqual({ id: 28, capability: "supported", mode: "off", access: null });
    expect(cookies.find((entry) => entry.name === "fleet_console_pairing_8443")?.value).toBe("newer-fixture");
    expect(windowCookies.find((entry) => entry.url === origin && entry.name === "fleet_console_pairing_8443")?.value).toBe("newer-fixture");
    expect(windowCookies.find((entry) => entry.url === otherOrigin)?.value).toBe("other-port");
    expect(posts.some((entry) => entry.url.includes("/api/v1/join"))).toBe(false);
    grantCookie = "pairing-secret";

    presenceReject = false;
    pauseForgetRead = false;
  });

  it("does not let a command from a released console lifetime commit into the next one", async () => {
    const target = { hostname: "remote.example", port: 8443, fingerprint: "AB".repeat(32) };
    const cookies = [{ name: "fleet_console_pairing_8443", value: "existing" }];
    let hold = true;
    let entered: () => void = () => undefined;
    let letGo: () => void = () => undefined;
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { letGo = resolve; });
    const executor = createHostTransportExecutor({
      cookieOrder: createCookieOrder(),
      confirmIdentity: async () => undefined,
      openPartition: () => ({
        fetch: async (url: string) => (url.endsWith("/pair") ? new Response(null, { status: 204 }) : Response.json({ capability: "host-session", mode: "observer", access: "full" })),
        readCookies: async () => cookies,
        writeCookie: async () => undefined,
        pin() { return undefined; },
        clear() { return undefined; },
      }),
      readWindowCookies: async () => cookies,
      writeWindowCookie: async () => { if (hold) { hold = false; entered(); await gate; } },
      localOrigin: () => "http://127.0.0.1:4010",
      localFetch: async () => { throw new Error("unexpected_handoff"); },
    });
    const base = { hostKey: "host1", epoch: 1, routeId: "abort", target };
    for (let id = 1; id <= 5; id += 1) await executor.execute({ ...base, id, op: "abort", params: { commandId: 99999 } });
    const old = executor.execute({ ...base, id: 6, op: "presence", routeId: "presence", params: { intent: "observe" } });
    await writing;
    executor.releaseConsole();
    letGo();
    await old;
    // 새 수명은 id를 1부터 다시 쓴다. 옛 수명의 늦은 확정이 더 큰 번호로 남아 있으면 이 pair가 막힌다.
    const fresh = await executor.execute({ ...base, id: 1, op: "pair", routeId: "pair", params: {} });
    expect(fresh).toEqual({ id: 1, capability: "supported", mode: "off", access: null });
  });

  it("orders cookie-bearing requests per origin when the jar is written as a response resolves", async () => {
    // N1이 Electron에서 본 순서(응답 직전 jar 적용, 응답 뒤 abort는 무효)를 가짜 fetch로 흉내 낸 모델이다. 실제 Electron 검증이 아니다.
    const target = { hostname: "remote.example", port: 8443, fingerprint: "AB".repeat(32) };
    const pairing = "fleet_console_pairing_8443";
    const jar = new Map<string, string>();
    const windowJar = new Map<string, string>();
    const requests: string[] = [];
    const observes: { settle: () => void }[] = [];
    let rejectOnAbort = false;
    let handoffs = 0;
    const pairCount = (): number => requests.filter((entry) => entry.startsWith("pair:")).length;
    const executor = createHostTransportExecutor({
      cookieOrder: createCookieOrder(),
      confirmIdentity: async () => undefined,
      openPartition: () => ({
        fetch: (url: string, init?: RequestInit) => {
          if (url.endsWith("/api/v1/sessions")) {
            requests.push("sessions");
            const rejects = rejectOnAbort;
            return new Promise<Response>((resolve, reject) => {
              let aborted = false;
              init?.signal?.addEventListener("abort", () => { aborted = true; if (rejects) reject(new DOMException("aborted", "AbortError")); }, { once: true });
              observes.push({ settle: () => {
                if (aborted && rejects) return;
                jar.set(pairing, "OLD");
                resolve(Response.json({ capability: "host-session", mode: "observer", access: "full" }));
              } });
            });
          }
          if (url.endsWith("/api/v1/pair")) {
            const probe = init?.body === "{}";
            requests.push(probe ? "pair:probe" : "pair:grant");
            if (!probe) {
              jar.set(pairing, "NEW");
              return Promise.resolve(new Response(null, { status: 204, headers: { "set-cookie": `${pairing}=NEW; HttpOnly; Secure; Path=/` } }));
            }
            const value = jar.get(pairing);
            if (value === "NEW") return Promise.resolve(new Response(null, { status: 204 }));
            if (value === "OLD") return Promise.resolve(Response.json({ error: "unauthorized", capability: "pair" }, { status: 401 }));
            return Promise.resolve(Response.json({ error: "invalid_join", capability: "pair" }, { status: 400 }));
          }
          requests.push(new URL(url).pathname);
          if (url.endsWith("/api/v1/operations/events")) return Promise.resolve(new Response("event: x\n\n", { status: 200 }));
          return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
        },
        readCookies: async () => [...jar].map(([name, value]) => ({ name, value })),
        writeCookie: async (cookie: { name: string; value: string }) => { jar.set(cookie.name, cookie.value); },
        removeCookie: async (_url: string, name: string) => { jar.delete(name); },
        pin() { return undefined; },
        clear() { jar.clear(); },
      }),
      readWindowCookies: async () => [...windowJar].map(([name, value]) => ({ name, value })),
      writeWindowCookie: async (cookie) => { windowJar.set(cookie.name, cookie.value); },
      removeWindowCookie: async (_url, name) => { windowJar.delete(name); },
      localOrigin: () => "http://127.0.0.1:4010",
      localFetch: async () => {
        handoffs += 1;
        return Response.json({ origin: "https://remote.example:8443", hostname: target.hostname, port: target.port, fingerprint: target.fingerprint, token: `grant-${handoffs}` });
      },
    });
    const base = { hostKey: "host1", epoch: 1, target };
    const observe = (id: number, signal?: AbortSignal) => executor.execute({ ...base, id, op: "presence", routeId: "presence", params: { intent: "observe" } }, signal);
    const pair = (id: number, signal?: AbortSignal) => executor.execute({ ...base, id, op: "pair", routeId: "pair", params: {} }, signal);
    const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

    // 이전 observe의 응답이 늦다. 새 pair는 보내지 않고 기다리며, 읽기와 SSE는 막히지 않는다.
    const oldObserve = observe(1);
    await waitFor(() => observes.length === 1);
    const fresh = pair(2);
    await quiet();
    expect(pairCount()).toBe(0);
    expect(await executor.execute({ ...base, id: 3, op: "http", routeId: "theaters", params: { method: "GET", path: "/api/v1/theaters" } })).toMatchObject({ status: 200 });
    const frames: unknown[] = [];
    await executor.run({ ...base, id: 4, op: "sse", routeId: "operation-events", params: { path: "/api/v1/operations/events" } }, async (relay) => { frames.push(relay); });
    expect(frames.length).toBeGreaterThan(0);
    expect(pairCount()).toBe(0);
    observes[0]?.settle();
    expect(await oldObserve).toMatchObject({ capability: "supported", mode: "observer" });
    expect(await fresh).toEqual({ id: 2, capability: "supported", mode: "off", access: null });
    expect(jar.get(pairing)).toBe("NEW");
    expect(windowJar.get(pairing)).toBe("NEW");
    expect(handoffs).toBe(1);

    // 줄 선 요청을 취소하면 요청을 보내지 않고 빠지며, 보유자가 끝나면 다음이 진행한다.
    const holder = observe(5);
    await waitFor(() => observes.length === 2);
    const queued = new AbortController();
    const cancelled = pair(6, queued.signal);
    await quiet();
    const sentBefore = pairCount();
    queued.abort();
    expect(await cancelled).toMatchObject({ error: "remote_host_unavailable" });
    expect(pairCount()).toBe(sentBefore);
    observes[1]?.settle();
    await holder;

    // 줄이 가득 차면 새 요청은 보내지 않고 바로 거절한다. 줄 선 요청은 취소하면 모두 빠진다.
    jar.set(pairing, "NEW");
    const longHolder = observe(10);
    await waitFor(() => observes.length === 3);
    const waiting = Array.from({ length: 8 }, (_, index) => ({ abort: new AbortController(), id: 11 + index }));
    const waits = waiting.map((entry) => pair(entry.id, entry.abort.signal));
    await quiet();
    const sentFull = pairCount();
    expect(await pair(30)).toMatchObject({ error: "remote_host_unavailable", end: true });
    expect(pairCount()).toBe(sentFull);
    for (const entry of waiting) entry.abort.abort();
    expect((await Promise.all(waits)).every((relay) => relay.error === "remote_host_unavailable")).toBe(true);
    observes[2]?.settle();
    await longHolder;

    // 취소로 fetch가 거절된 보유자는 오류로 끝나고 다음 요청이 진행한다.
    rejectOnAbort = true;
    const abortHolder = new AbortController();
    const aborting = observe(40, abortHolder.signal);
    await waitFor(() => observes.length === 4);
    const afterAbort = pair(41);
    abortHolder.abort();
    expect(await aborting).toMatchObject({ error: "remote_host_unavailable" });
    expect(await afterAbort).toMatchObject({ capability: "supported", mode: "off" });
    rejectOnAbort = false;

    // 새 콘솔 수명이 시작돼도 옛 수명의 fetch가 settle되기 전에는 같은 origin의 쿠키 요청을 열지 않는다.
    jar.delete(pairing);
    windowJar.delete(pairing);
    const oldLifetime = observe(50);
    await waitFor(() => observes.length === 5);
    executor.releaseConsole();
    const sentAtRelease = pairCount();
    const nextLifetime = pair(1);
    await quiet();
    expect(pairCount()).toBe(sentAtRelease);
    observes[4]?.settle();
    await oldLifetime;
    expect(await nextLifetime).toMatchObject({ capability: "supported", mode: "off" });
    expect(jar.get(pairing)).toBe("NEW");
    expect(windowJar.get(pairing)).toBe("NEW");
  });

  /**
   * 실제 어댑터(`createHostPartitionAdapter`)를 지나는 가짜 네이티브 Session으로 본다. Electron 문서의 의미를 흉내 낸 모델이며
   * 실제 Electron 실행 증거가 아니다: `expirationDate`가 없으면 session 쿠키, `domain`을 되넘기면 호스트 한정이 domain 쿠키로 승격,
   * `fetch`는 응답을 돌려주기 전에 Set-Cookie를 jar에 적용한다.
   */
  it("keeps the server-issued cookie lifetime and scope, and drops the old target's credentials on replacement", async () => {
    interface FakeCookie { name: string; value: string; domain: string; hostOnly: boolean; path: string; secure: boolean; httpOnly: boolean; expirationDate?: number; sameSite: "unspecified" | "no_restriction" | "lax" | "strict"; session: boolean }
    const host = "remote.example";
    const origin = `https://${host}:8443`;
    const pairing = "fleet_console_pairing_8443";
    const sessionName = "fleet_console_session_8443";
    const nativeSession = (applySetCookie: boolean) => {
      const jar = new Map<string, FakeCookie>();
      const sets: Record<string, unknown>[] = [];
      const requests: { path: string; body: string; cookies: string[] }[] = [];
      const state = { clears: 0 };
      const store = (details: Record<string, unknown>): void => {
        sets.push(details);
        const domain = typeof details.domain === "string" ? details.domain : null;
        jar.set(String(details.name), {
          name: String(details.name), value: String(details.value), domain: domain === null ? host : `.${domain.replace(/^\./u, "")}`, hostOnly: domain === null,
          path: typeof details.path === "string" ? details.path : "/", secure: details.secure === true, httpOnly: details.httpOnly === true,
          ...(typeof details.expirationDate === "number" ? { expirationDate: details.expirationDate } : {}),
          sameSite: details.sameSite === "strict" || details.sameSite === "lax" || details.sameSite === "no_restriction" ? details.sameSite : "unspecified", session: typeof details.expirationDate !== "number",
        });
      };
      const applyHeader = (line: string): void => {
        const [first = "", ...attrs] = line.split(";").map((part) => part.trim());
        const eq = first.indexOf("=");
        const lower = attrs.map((attr) => attr.toLowerCase());
        const maxAge = lower.find((attr) => attr.startsWith("max-age="));
        store({
          name: first.slice(0, eq), value: first.slice(eq + 1), path: "/", secure: lower.includes("secure"), httpOnly: lower.includes("httponly"),
          ...(maxAge ? { expirationDate: Math.floor(Date.now() / 1000) + Number(maxAge.slice(8)) } : {}),
          ...(lower.includes("samesite=strict") ? { sameSite: "strict" } : {}),
        });
      };
      const native = {
        fetch: async (url: string, init?: RequestInit) => {
          requests.push({ path: new URL(url).pathname, body: typeof init?.body === "string" ? init.body : "", cookies: [...jar.values()].map((cookie) => `${cookie.name}=${cookie.value}`) });
          const response = await remote(url, init);
          if (applySetCookie) for (const line of response.headers.getSetCookie()) applyHeader(line);
          return response;
        },
        clearStorageData: async () => { state.clears += 1; jar.clear(); },
        cookies: {
          get: async () => [...jar.values()].map((cookie) => ({ ...cookie })),
          set: async (details: Record<string, unknown>) => { store(details); },
          remove: async (_url: string, name: string) => { jar.delete(name); },
        },
      };
      return { native, jar, sets, requests, state };
    };
    let grantHeader = `${pairing}=fresh; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000; Secure`;
    const sessionGate: { hold: boolean; release: (() => void) | null } = { hold: false, release: null };
    const remote = async (url: string, init?: RequestInit): Promise<Response> => {
      const path = new URL(url).pathname;
      if (path === "/api/v1/sessions" && sessionGate.hold) {
        sessionGate.hold = false;
        return new Promise<Response>((resolve) => {
          sessionGate.release = () => resolve(new Response(JSON.stringify({ capability: "host-session", mode: "observer", access: "full" }), { status: 200, headers: { "content-type": "application/json", "set-cookie": `${sessionName}=late; HttpOnly; Path=/; Secure` } }));
        });
      }
      if (path === "/api/v1/pair") {
        if (init?.body === "{}") return Response.json({ error: "invalid_join", capability: "pair" }, { status: 400 });
        return new Response(null, { status: 204, headers: { "set-cookie": grantHeader } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const fingerprintOf = (letter: string): string => letter.repeat(64);
    const build = (applySetCookie: boolean) => {
      const partition = nativeSession(applySetCookie);
      const windowJar = nativeSession(false);
      const current = { fingerprint: fingerprintOf("A"), mismatch: null as string | null, unreachable: false };
      // 지문별로 확인을 쥐고 있다가 풀어 주는 게이트와, 어댑터가 받은 핀 호출 기록.
      const confirmGates = new Map<string, Promise<void>>();
      const pinLog: string[] = [];
      const cookieOrder = createCookieOrder();
      let handoffs = 0;
      const executor = createHostTransportExecutor({
        cookieOrder,
        confirmIdentity: async (_host, _port, fingerprint) => {
          if (current.unreachable) throw new Error("connect_failed");
          if (current.mismatch === fingerprint) throw new Error("remote_link_fingerprint_mismatch");
          await confirmGates.get(fingerprint);
        },
        openPartition: () => createHostPartitionAdapter(partition.native as never, { pin(_hostname: string, fingerprint: string) { pinLog.push(fingerprint); }, clear() { return undefined; } }),
        readWindowCookies: async () => windowJar.native.cookies.get(),
        writeWindowCookie: async (cookie) => { await windowJar.native.cookies.set(cookie as never); },
        removeWindowCookie: async (_url, name) => { await windowJar.native.cookies.remove(origin, name); },
        localOrigin: () => "http://127.0.0.1:4010",
        localFetch: async () => { handoffs += 1; return Response.json({ origin, hostname: host, port: 8443, fingerprint: current.fingerprint, token: `grant-${handoffs}` }); },
      });
      const command = (id: number, op: "pair" | "presence" | "http" = "pair") => ({
        id, hostKey: "host1", epoch: 1, op, routeId: op, params: op === "presence" ? { intent: "observe" } : op === "http" ? { method: "GET", path: "/api/v1/theaters" } : {},
        target: { hostname: host, port: 8443, fingerprint: current.fingerprint },
      });
      return { executor, partition, windowJar, current, command, cookieOrder, confirmGates, pinLog };
    };
    const expected = (): number => Math.floor(Date.now() / 1000) + 31536000;

    // 네이티브가 응답을 적용한다: 같은 값이라는 이유로 명시 set을 하지 않아 서버가 준 만료·SameSite·host-only 범위가 두 jar에 남는다.
    const applied = build(true);
    expect(await applied.executor.execute(applied.command(1))).toMatchObject({ capability: "supported", mode: "off" });
    for (const jar of [applied.partition.jar, applied.windowJar.jar]) {
      const cookie = jar.get(pairing);
      expect(cookie?.value).toBe("fresh");
      expect(Math.abs((cookie?.expirationDate ?? 0) - expected())).toBeLessThan(10);
      expect(cookie).toMatchObject({ sameSite: "strict", hostOnly: true, session: false });
    }
    for (const entry of [...applied.partition.sets, ...applied.windowJar.sets]) {
      expect(entry).not.toHaveProperty("domain");
      expect(entry).not.toHaveProperty("hostOnly");
    }

    // 네이티브가 적용하지 못한 경우(fallback): 서버의 Max-Age에서만 만료를 도출하고 자체 TTL을 더하지 않는다.
    const fallback = build(false);
    expect(await fallback.executor.execute(fallback.command(1))).toMatchObject({ capability: "supported", mode: "off" });
    const written = fallback.windowJar.jar.get(pairing);
    expect(Math.abs((written?.expirationDate ?? 0) - expected())).toBeLessThan(10);
    expect(written).toMatchObject({ sameSite: "strict", hostOnly: true, session: false });
    grantHeader = `${pairing}=fresh; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure`;
    const expiredGrant = build(false);
    expect(await expiredGrant.executor.execute(expiredGrant.command(1))).toMatchObject({ error: "remote_host_unavailable" });
    expect(expiredGrant.windowJar.jar.has(pairing)).toBe(false);
    grantHeader = `${pairing}=fresh; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000; Secure`;

    // 새로 등록된 지문으로 대상이 바뀌면 옛 대상의 자격은 새 endpoint로 가지 않는다. 같은 Session을 다시 열기만 해서는 비워지지 않는다.
    applied.partition.jar.set(sessionName, { name: sessionName, value: "old-session", domain: host, hostOnly: true, path: "/", secure: true, httpOnly: true, sameSite: "strict", session: true });
    applied.windowJar.jar.set("fleet_console_pairing_9443", { name: "fleet_console_pairing_9443", value: "other-port", domain: host, hostOnly: true, path: "/", secure: true, httpOnly: true, sameSite: "strict", session: true });
    // 신뢰 실패(지문 불일치)는 교체가 아니다: 아무것도 지우지 않는다.
    applied.current.fingerprint = fingerprintOf("E");
    applied.current.mismatch = fingerprintOf("E");
    expect(await applied.executor.execute(applied.command(2))).toMatchObject({ error: "remote_host_fingerprint_mismatch" });
    expect(applied.partition.state.clears).toBe(0);
    expect(applied.partition.jar.get(pairing)?.value).toBe("fresh");
    expect(applied.windowJar.jar.get(pairing)?.value).toBe("fresh");
    applied.current.mismatch = null;
    applied.current.fingerprint = fingerprintOf("C");
    const requestsBefore = applied.partition.requests.length;
    expect(await applied.executor.execute(applied.command(3))).toMatchObject({ capability: "supported", mode: "off" });
    expect(applied.partition.state.clears).toBe(1);
    // 교체 뒤 새 대상으로 나간 첫 요청에는 옛 페어링·세션이 실리지 않았다.
    expect(applied.partition.requests[requestsBefore]?.cookies).toEqual([]);
    expect(applied.windowJar.jar.get("fleet_console_pairing_9443")?.value).toBe("other-port");
    expect(applied.windowJar.jar.get(pairing)?.value).toBe("fresh");

    // 옛 origin에서 진행 중인 쿠키 요청이 끝나기 전에는 비우지 않고, 늦은 응답이 지운 자격을 되살리지 못한다.
    applied.current.fingerprint = fingerprintOf("C");
    sessionGate.hold = true;
    const oldObserve = applied.executor.execute(applied.command(4, "presence"));
    await waitFor(() => sessionGate.release !== null);
    applied.current.fingerprint = fingerprintOf("D");
    const clearsBefore = applied.partition.state.clears;
    const replacing = applied.executor.execute(applied.command(5, "http"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(applied.partition.state.clears).toBe(clearsBefore);
    sessionGate.release?.();
    await oldObserve;
    expect(await replacing).toMatchObject({ status: 200 });
    expect(applied.partition.state.clears).toBe(clearsBefore + 1);
    expect(applied.partition.jar.has(sessionName)).toBe(false);
    expect(applied.partition.requests.at(-1)?.cookies).toEqual([]);

    // 대상 교체의 파괴적 동작은 각 await 뒤 현재성을 다시 본다. 정상 쿠키를 심어 두고 어느 경계에서도 지워지지 않는지 본다.
    const seed = (): void => {
      for (const jar of [applied.partition.jar, applied.windowJar.jar]) {
        jar.set(pairing, { name: pairing, value: "kept", domain: host, hostOnly: true, path: "/", secure: true, httpOnly: true, sameSite: "strict", session: false, expirationDate: expected() });
      }
    };
    const kept = (): void => {
      expect(applied.partition.jar.get(pairing)?.value).toBe("kept");
      expect(applied.windowJar.jar.get(pairing)?.value).toBe("kept");
    };
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

    // 일반 네트워크 실패는 신뢰 판정이 아니다: 쿠키와 파티션은 그대로다.
    seed();
    applied.current.fingerprint = fingerprintOf("4");
    applied.current.unreachable = true;
    expect(await applied.executor.execute(applied.command(6))).toMatchObject({ error: "remote_host_unreachable" });
    applied.current.unreachable = false;
    kept();

    // (a) 지문 확인이 보류된 동안 취소되면 비우지도 핀을 바꾸지도 않는다.
    seed();
    let openF = (): void => undefined;
    applied.confirmGates.set(fingerprintOf("F"), new Promise<void>((resolve) => { openF = resolve; }));
    applied.current.fingerprint = fingerprintOf("F");
    const clearsA = applied.partition.state.clears;
    const pinsA = applied.pinLog.length;
    const abortA = new AbortController();
    const pendingA = applied.executor.execute(applied.command(7), abortA.signal);
    await settle();
    abortA.abort();
    openF();
    expect(await pendingA).toMatchObject({ error: "remote_host_unavailable" });
    expect(applied.partition.state.clears).toBe(clearsA);
    expect(applied.pinLog.length).toBe(pinsA);
    kept();

    // (b) 옛 대상의 확인이 보류된 사이 더 늦게 시작한 새 대상이 확정·처리된 뒤 옛 확인이 돌아와도, 새 대상의 쿠키·핀·파티션은 그대로다.
    seed();
    let openG = (): void => undefined;
    applied.confirmGates.set(fingerprintOf("1"), new Promise<void>((resolve) => { openG = resolve; }));
    applied.current.fingerprint = fingerprintOf("1");
    const oldRun = applied.executor.execute(applied.command(8, "http"));
    await settle();
    applied.current.fingerprint = fingerprintOf("2");
    expect(await applied.executor.execute(applied.command(9))).toMatchObject({ capability: "supported", mode: "off" });
    const clearsB = applied.partition.state.clears;
    const pinsB = applied.pinLog.length;
    const pairingAfterNew = applied.partition.jar.get(pairing)?.value;
    expect(pairingAfterNew).toBe("fresh");
    openG();
    expect(await oldRun).toMatchObject({ error: "stale_epoch" });
    expect(applied.partition.state.clears).toBe(clearsB);
    expect(applied.pinLog.length).toBe(pinsB);
    expect(applied.pinLog.at(-1)).toBe(fingerprintOf("2"));
    expect(applied.partition.jar.get(pairing)?.value).toBe("fresh");
    expect(applied.windowJar.jar.get(pairing)?.value).toBe("fresh");

    // (c) 교체가 순서를 얻은 직후 취소되면 아무것도 지우지 않는다(순서를 쥐는 쪽이 넘겨준 뒤 첫 확인에서 걸린다).
    seed();
    applied.current.fingerprint = fingerprintOf("3");
    const heldOrder = await applied.cookieOrder.hold(origin, new AbortController().signal);
    const abortC = new AbortController();
    const replacingC = applied.executor.execute(applied.command(10, "http"), abortC.signal);
    await settle();
    const clearsC = applied.partition.state.clears;
    heldOrder?.();
    abortC.abort();
    expect(await replacingC).toMatchObject({ error: "remote_host_unavailable" });
    expect(applied.partition.state.clears).toBe(clearsC);
    kept();
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
      cookieOrder: createCookieOrder(),
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

  it("returns a stored image at the product limit as one resource and refuses a larger one", async () => {
    // 원격 첨부 미리보기: 제품이 받는 가장 큰 이미지는 그대로 돌려주고, 그보다 큰 응답은 자원 통로로 넘기지 않는다.
    const sizes = new Map([["full", HOST_RESOURCE_MAX_BYTES], ["over", HOST_RESOURCE_MAX_BYTES + 1]]);
    const executor = createHostTransportExecutor({
      cookieOrder: createCookieOrder(),
      confirmIdentity: async () => undefined,
      openPartition: () => ({
        ...partition,
        async fetch(url: string) {
          const size = sizes.get(new URL(url).searchParams.get("attachmentId") ?? "");
          return size === undefined ? new Response("no", { status: 404 }) : new Response(Buffer.alloc(size, 1), { status: 200, headers: { "content-type": "image/png" } });
        },
      }),
      readWindowCookies: async () => [],
      writeWindowCookie: async () => undefined,
    });
    const read = (id: number, attachmentId: string) => executor.execute({
      id, hostKey: "host1", epoch: 2, op: "bytes", routeId: "objective-attachment", target, params: { method: "GET", path: `/plugins/objectives/attachment/file?objectiveId=a&attachmentId=${attachmentId}` },
    });
    const full = await read(6, "full");
    expect(full).toMatchObject({ status: 200, contentType: "image/png" });
    expect(Buffer.from(full.dataBase64 ?? "", "base64").length).toBe(HOST_RESOURCE_MAX_BYTES);
    await expect(read(7, "over")).resolves.toMatchObject({ error: "remote_host_unavailable" });
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
      cookieOrder: createCookieOrder(),
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
      cookieOrder: createCookieOrder(),
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
      cookieOrder: createCookieOrder(),
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
