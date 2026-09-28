import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sessionCookieName } from "../features/remote-access/host/auth.js";
import { createProxyBroker, type ProxyBroker } from "../features/remote-access/host/proxy/broker.js";
import type { RemoteHostRecord } from "../features/remote-access/host/remote-hosts.js";
import { createRemoteIdentityStore } from "../features/remote-access/host/remote-identity.js";

// 읽기 전용 원격 데이터 epoch의 보안 경계. 실제 TLS로 선 가짜 원격 콘솔을 상대로, broker가 받는 위임과
// epoch 리스너가 내주는 것·막는 것·끝내는 순서를 공개 문(broker의 HTTP 핸들러와 epoch 리스너)에서 본다.

const LOCK = "lock-token";
const VERSION = "1.0.0";
const SESSION = "s".repeat(43);

interface RemoteRequest { readonly method: string; readonly url: string; readonly headers: http.IncomingHttpHeaders }

interface FakeRemote {
  readonly port: number;
  readonly fingerprint: string;
  readonly requests: RemoteRequest[];
  readonly streams: http.ServerResponse[];
  access: string;
  tcpConnections: number;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-epoch-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function startRemote(): Promise<FakeRemote> {
  const identity = await createRemoteIdentityStore(tempDir()).ensure("127.0.0.1");
  const remote: FakeRemote = { port: 0, fingerprint: identity.fingerprint, requests: [], streams: [], access: "monitoring", tcpConnections: 0 };
  const server = https.createServer({ cert: identity.certificatePem, key: identity.privateKeyPem }, (req, res) => {
    remote.requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    const json = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && req.url === "/api/v1/access/self") return json(200, { access: remote.access });
    if (req.method === "GET" && req.url === "/api/v1/status") return json(200, { name: "Remote‮ box", workspaces: 3, version: VERSION, wikiServerStatus: "available" });
    if (req.method === "GET" && req.url === "/api/v1/theaters") return json(200, { theaters: [] });
    if (req.method === "GET" && req.url === "/api/v1/operations/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      remote.streams.push(res);
      return;
    }
    if (req.method === "POST" && req.url === "/api/v1/access/self/leave") { req.resume(); res.writeHead(204); res.end(); return; }
    json(404, { error: "not_found" });
  });
  server.on("connection", () => { remote.tcpConnections += 1; });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  (remote as { port: number }).port = (server.address() as net.AddressInfo).port;
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return remote;
}

async function startBroker(host: RemoteHostRecord): Promise<{ readonly port: number; readonly broker: ProxyBroker }> {
  const broker = createProxyBroker({
    remoteHostStore: { find: (id) => (id === host.id ? host : null) },
    isLockAuthorized: (req) => req.headers.authorization === `Bearer ${LOCK}`,
    localVersion: () => VERSION,
    presentation: () => ({ theme: "instrument", liquidGlass: true, unfocusedPanelFade: 50, uiFont: { source: "system", familyName: "Secret Font", size: 14 }, language: "auto" }),
    readAsset: (relative) => (relative === "index.html" ? { contentType: "text/html; charset=utf-8", body: "<html><head></head><body></body></html>", immutable: false } : null),
  });
  let port = 0;
  const server = http.createServer((req, res) => {
    if (!broker.handle(req, res, new URL(req.url ?? "/", "http://x").pathname, port)) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
  cleanups.push(() => new Promise<void>((resolve) => { broker.shutdown(); server.closeAllConnections(); server.close(() => resolve()); }));
  return { port, broker };
}

function hostRecord(remote: FakeRemote, fingerprint = remote.fingerprint): RemoteHostRecord {
  return { id: "host-1", label: "Remote", origin: `https://127.0.0.1:${remote.port}`, hostname: "127.0.0.1", port: remote.port, fingerprint, addedAt: 0, lastOpenedAt: null, pinGeneration: 1, cookieBinding: null };
}

interface Reply { readonly status: number; readonly headers: http.IncomingHttpHeaders; readonly body: string }

function request(port: number, method: string, target: string, headers: http.OutgoingHttpHeaders = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: target, headers: { host: `127.0.0.1:${port}`, ...headers }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** 요청 한 줄을 그대로 보내고, 소켓이 닫힐 때까지 받은 바이트를 돌려준다. */
function rawExchange(port: number, text: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    setTimeout(() => socket.destroy(), 2_000);
  });
}

const native = (extra: http.OutgoingHttpHeaders = {}) => ({ authorization: `Bearer ${LOCK}`, ...extra });

async function openOwner(port: number): Promise<string> {
  const reply = await request(port, "POST", "/api/v1/proxy/owners", native());
  expect(reply.status).toBe(201);
  return (JSON.parse(reply.body) as { ownerLeaseId: string }).ownerLeaseId;
}

function delegation(owner: string, remote: FakeRemote, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    requestId: crypto.randomUUID(),
    ownerLeaseId: owner,
    switchGeneration: 1,
    hostId: "host-1",
    pinGeneration: 1,
    session: { name: sessionCookieName(remote.port), value: SESSION },
    ...overrides,
  });
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("remote data epoch", () => {
  it("serves a verified monitoring session read-only behind the epoch capability and ends it on reclaim without leaving", async () => {
    const remote = await startRemote();
    const { port } = await startBroker(hostRecord(remote));
    const owner = await openOwner(port);
    const events: string[] = [];
    const ownerStream = http.get({ host: "127.0.0.1", port, path: `/api/v1/proxy/events?owner=${owner}`, headers: { host: `127.0.0.1:${port}`, ...native() }, agent: false }, (res) => res.on("data", (chunk: Buffer) => events.push(chunk.toString("utf8"))));
    cleanups.push(() => { ownerStream.destroy(); });

    // 브라우저 Origin이 실린 broker 요청과, pairing 같은 다른 자격은 위임받지 않는다.
    expect((await request(port, "POST", "/api/v1/proxy/epochs", native({ origin: `http://127.0.0.1:${port}` }), delegation(owner, remote))).status).toBe(401);
    expect((await request(port, "POST", "/api/v1/proxy/epochs", native(), delegation(owner, remote, { session: { name: `fleet_console_pairing_${remote.port}`, value: SESSION } }))).status).toBe(400);
    expect(remote.requests).toHaveLength(0);
    // full 세션은 읽기 전용 프록시가 받지 않는다 — 검증된 monitoring만.
    remote.access = "full";
    const refused = await request(port, "POST", "/api/v1/proxy/epochs", native(), delegation(owner, remote));
    expect([refused.status, JSON.parse(refused.body)]).toEqual([409, { error: "access_not_monitoring" }]);
    remote.access = "monitoring";

    const issued = await request(port, "POST", "/api/v1/proxy/epochs", native(), delegation(owner, remote));
    expect(issued.status).toBe(201);
    const epoch = JSON.parse(issued.body) as { epochId: string; origin: string; cookieName: string; capability: string };
    const epochPort = Number(new URL(epoch.origin).port);
    const cookie = `${epoch.cookieName}=${epoch.capability}`;
    const same = { cookie, "sec-fetch-site": "same-origin" };

    // 정적 부트스트랩까지 capability가 없으면 닫혀 있고, 다른 origin은 capability가 있어도 안 된다.
    expect((await request(epochPort, "GET", "/console/")).status).toBe(401);
    expect((await request(epochPort, "GET", "/console/", { cookie, origin: "http://evil.test" })).status).toBe(401);
    const index = await request(epochPort, "GET", "/console/", same);
    expect(index.status).toBe(200);
    expect(index.body).toContain('<meta name="fleet-surface" content="proxy-data">');
    expect(index.headers["content-security-policy"]).toContain("connect-src 'self'");

    // status는 표시 중인 원격의 이름·규모와 로컬 번들 버전으로 나뉜다. 원격 문자열의 서식 문자는 걷힌다.
    const status = JSON.parse((await request(epochPort, "GET", "/api/v1/status", same)).body) as Record<string, unknown>;
    expect(status).toMatchObject({ name: "Remote box", workspaces: 3, version: VERSION, updateAvailable: false, port: epochPort, surface: "proxy-data" });
    // 설정은 표현 값만. 이 기계의 시스템 서체 이름은 원격 화면으로 새지 않는다.
    expect((await request(epochPort, "GET", "/api/v1/settings/global", same)).body).not.toContain("Secret Font");

    expect((await request(epochPort, "GET", "/api/v1/theaters", same)).status).toBe(200);
    expect(remote.requests.find((entry) => entry.url === "/api/v1/theaters")?.headers.cookie).toBe(`${sessionCookieName(remote.port)}=${SESSION}`);

    // 쓰기·조인·로컬 control-plane·프록시 요청·WS는 원격에도 로컬에도 닿지 않는다.
    const before = remote.requests.length;
    expect((await request(epochPort, "POST", "/api/v1/operations", { ...same, "content-type": "application/json" }, "{}")).status).toBe(404);
    expect((await request(epochPort, "GET", "/api/v1/remote-hosts", same)).status).toBe(404);
    expect((await request(epochPort, "GET", "/mcp/fleet", same)).status).toBe(404);
    expect(JSON.parse((await request(epochPort, "POST", "/api/v1/join", same, "{}")).body)).toMatchObject({ error: "session_resume_refused" });
    expect(await rawExchange(epochPort, `GET http://127.0.0.1:${port}/api/v1/proxy/owners HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${cookie}\r\n\r\n`)).toMatch(/^HTTP\/1\.1 400/u);
    expect(await rawExchange(epochPort, `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`)).toBe("");
    expect(await rawExchange(epochPort, `GET /api/v1/terminal/ws HTTP/1.1\r\nHost: 127.0.0.1:${epochPort}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`)).toMatch(/^HTTP\/1\.1 403/u);
    expect(remote.requests.slice(before).map((entry) => entry.url)).toEqual([]);

    // 원격 스트림은 허용목록 이벤트만 흐른다.
    const relayed: string[] = [];
    let downstreamClosed = false;
    const downstream = http.get({ host: "127.0.0.1", port: epochPort, path: "/api/v1/operations/events", headers: { host: `127.0.0.1:${epochPort}`, ...same }, agent: false }, (res) => {
      res.on("data", (chunk: Buffer) => relayed.push(chunk.toString("utf8")));
      res.on("close", () => { downstreamClosed = true; });
    });
    downstream.on("error", () => undefined);
    await waitFor(() => remote.streams.length === 2);
    remote.streams[1]!.write('event: control:changed\ndata: {"holder":null}\n\nevent: desktop:window\ndata: {}\n\nevent: operation:changed\ndata: {"id":"op-1"}\n\n');
    await waitFor(() => relayed.join("").includes("operation:changed"));
    expect(relayed.join("")).not.toMatch(/control:|desktop:/u);

    // 회수는 broker 전용 control stream에서만 판정한다. terminal이면 리스너가 닫히고 원격을 떠나지 않는다.
    remote.streams[0]!.write('event: control:reclaimed\ndata: {"reason":"reclaimed"}\n\n');
    await waitFor(() => events.join("").includes('"reason":"reclaimed"'));
    await expect(request(epochPort, "GET", "/api/v1/theaters", same)).rejects.toThrow();
    await waitFor(() => downstreamClosed);
    expect(remote.requests.some((entry) => entry.url === "/api/v1/access/self/leave")).toBe(false);
  });

  it("refuses a changed pin before sending any credential, and leaves the remote exactly once only on a final end", async () => {
    const remote = await startRemote();
    const other = await createRemoteIdentityStore(tempDir()).ensure("127.0.0.1");
    const host = { ...hostRecord(remote, other.fingerprint) };
    const { port } = await startBroker(host);
    const owner = await openOwner(port);

    const pinned = await request(port, "POST", "/api/v1/proxy/epochs", native(), delegation(owner, remote));
    expect([pinned.status, JSON.parse(pinned.body)]).toEqual([502, { error: "pin_rejected" }]);
    expect(remote.tcpConnections).toBeGreaterThan(0);
    expect(remote.requests).toHaveLength(0);

    Object.assign(host, { fingerprint: remote.fingerprint });
    const transfer = JSON.parse((await request(port, "POST", "/api/v1/proxy/epochs", native(), delegation(owner, remote))).body) as { epochId: string; generation: number };
    expect((await request(port, "DELETE", `/api/v1/proxy/epochs/${transfer.epochId}?owner=${owner}&generation=${transfer.generation}&mode=transfer`, native())).status).toBe(204);

    const final = JSON.parse((await request(port, "POST", "/api/v1/proxy/epochs", native(), delegation(owner, remote, { switchGeneration: 2 }))).body) as { epochId: string; generation: number; origin: string };
    expect((await request(port, "DELETE", `/api/v1/proxy/epochs/${final.epochId}?owner=${owner}&generation=${final.generation}&mode=final`, native())).status).toBe(204);
    await waitFor(() => remote.requests.some((entry) => entry.url === "/api/v1/access/self/leave"));
    const leaves = remote.requests.filter((entry) => entry.url === "/api/v1/access/self/leave");
    expect(leaves).toHaveLength(1);
    expect(leaves[0]!.headers).toMatchObject({ "content-length": "0", origin: `https://127.0.0.1:${remote.port}`, cookie: `${sessionCookieName(remote.port)}=${SESSION}` });
    await expect(request(Number(new URL(final.origin).port), "GET", "/console/")).rejects.toThrow();
  });
});
