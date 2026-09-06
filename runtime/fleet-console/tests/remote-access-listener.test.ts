import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createConsoleLock } from "../core/host/lock.js";
import { PAIRED_DEVICE_LIMIT } from "../core/host/paired-devices.js";
import { normalizeFingerprint } from "../core/host/remote-identity.js";
import { parseAccessLink } from "../core/host/access-link.js";
import { createConsoleServer, type ConsoleServer, type ConsoleServerDeps } from "../core/host/server.js";
import type { ConsoleRemoteAccessSettings } from "../core/host/settings/settings-domain.js";

// 원격 리스너는 자기 인증서로만 신원을 증명한다. 링크가 실어 나른 지문으로 검증해야
// 하므로, 테스트 클라이언트도 CA가 아니라 지문으로 서버를 확인한다.
//
// 루프백은 원격 바인드 주소로 거부되고(같은 포트를 이미 쓰는 리스너와도 충돌한다) 별칭
// 루프백은 바인드되지 않는 플랫폼이 있어, 이 머신이 실제로 가진 비내부 IPv4를 쓴다.
// 그런 주소가 없으면 원격을 열 수 없으므로 조용히 통과시키지 않고 눈에 띄게 건너뛴다.
const REMOTE_HOST = findBindableHost();
const BIND_HOST = REMOTE_HOST ?? "127.0.0.1";

function findBindableHost(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

interface Fixture {
  readonly dir: string;
  readonly server: ConsoleServer;
  readonly loopbackEndpoint: string;
  readonly remotePort: number;
  readonly lockToken: string;
  readonly fingerprint: string;
}

const servers: ConsoleServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.stop();
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { force: true, recursive: true });
});

describe.skipIf(REMOTE_HOST === null)("remote access listener", () => {
  it("stays closed until remote access is enabled", async () => {
    const fixture = await startFixture({ remote: false });

    const response = await fetch(`${fixture.loopbackEndpoint}api/v1/access-links`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.lockToken}` },
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "remote_access_disabled" });
  });

  it("serves the remote listener over tls with the fingerprint the link advertises", async () => {
    const fixture = await startFixture({ remote: true });
    const link = await createLink(fixture);
    const parsed = parseAccessLink(link);

    const presented = await readPresentedCertificateFingerprint(fixture.remotePort);

    expect(normalizeFingerprint(parsed.fingerprint)).toBe(normalizeFingerprint(presented));
    expect(parsed.origin).toBe(`https://${BIND_HOST}:${fixture.remotePort}`);
  });

  it("refuses every remote request that carries no session", async () => {
    const fixture = await startFixture({ remote: true });

    await expect(remoteRequest(fixture, "GET", "/api/v1/theaters")).resolves.toMatchObject({ status: 401 });
    await expect(remoteRequest(fixture, "GET", "/console/")).resolves.toMatchObject({ status: 401 });
    await expect(remoteRequest(fixture, "GET", "/api/v1/status")).resolves.toMatchObject({ status: 401 });
  });

  it("admits the console only after the link grant is exchanged", async () => {
    const fixture = await startFixture({ remote: true });
    const token = grantTokenOf(await createLink(fixture));

    const joined = await remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token }));
    expect(joined.status).toBe(204);
    const cookie = joined.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toContain("Secure");

    const session = cookie.split(";")[0]!;
    await expect(remoteRequest(fixture, "GET", "/api/v1/theaters", undefined, session)).resolves.toMatchObject({ status: 200 });
    await expect(remoteRequest(fixture, "GET", "/console/", undefined, session)).resolves.toMatchObject({ status: 200 });
  });

  it("refuses a loopback grant presented to the remote listener", async () => {
    const fixture = await startFixture({ remote: true });
    const issued = await fetch(`${fixture.loopbackEndpoint}api/v1/access-grants`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.lockToken}` },
    });
    const localGrant = (await issued.json() as { token: string }).token;

    const joined = await remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token: localGrant }));

    expect(joined.status).toBe(401);
  });

  it("leaves the join endpoint as the only door a session-less request can reach", async () => {
    const fixture = await startFixture({ remote: true });

    // 브라우저는 자기서명 인증서의 지문을 대조할 수 없어 페어링을 끝낼 수 없다. 설명 표면조차 두지 않는다.
    for (const path of ["/", "/join", "/console/", "/api/v1/state", "/api/v1/theaters", "/plugin-runtime/manifest"]) {
      await expect(remoteRequest(fixture, "GET", path)).resolves.toMatchObject({ status: 401 });
    }
    await expect(remoteRequest(fixture, "POST", "/join")).resolves.toMatchObject({ status: 401 });

    // 통과하는 것은 이 하나뿐이며, 자격이 없으면 401로 끝난다 — 열려 있다는 것과 들여보낸다는 것은 다르다.
    await expect(remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token: "not-a-grant" })))
      .resolves.toMatchObject({ status: 401 });
  });

  /**
   * 붙어 있는 원격은 하나다. 둘이 동시에 붙으면 커튼이 "누가" 몰고 있는지 하나로 말하지 못하고
   * 회수 버튼의 대상도 갈라진다. 그래서 둘째를 거절하는 대신 첫째를 대신한다 — 페어링 목록은
   * 둘 다 기억하되, 접속 줄은 언제나 하나만 살아 있다.
   */
  it("hands the single remote seat to the newest join and leaves the earlier pairing intact", async () => {
    const fixture = await startFixture({ remote: true });
    const first = await joinAs(fixture, "full", "first");
    const secondLink = await createLink(fixture);

    await expect(remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token: grantTokenOf(secondLink), device: "second" })))
      .resolves.toMatchObject({ status: 204 });

    // 페어링은 둘이지만 접속은 하나다. 살아 있는 줄은 방금 붙은 쪽이다.
    const held = await readRemoteStatus(fixture);
    expect(held.devices).toHaveLength(2);
    expect(held.devices.filter((entry) => entry.sessionHandle !== null).map((entry) => entry.device)).toEqual(["second"]);

    // 밀려난 기기의 세션 쿠키는 그 자리에서 죽는다.
    await expect(remoteRequest(fixture, "GET", "/api/v1/theaters", undefined, first)).resolves.toMatchObject({ status: 401 });

    // 그래도 그 기기는 자기 페어링으로 돌아와 자리를 되찾는다 — 축출이 자격까지 지우지는 않는다.
    const resumed = await remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({}), first);
    expect(resumed.status).toBe(204);
    await expect(readRemoteStatus(fixture).then((status) => status.devices.filter((entry) => entry.sessionHandle !== null).map((entry) => entry.device)))
      .resolves.toEqual(["first"]);
  });

  /** 저장된 것은 해시뿐이다 — 이 파일이 새어도 그것으로 붙을 수 없다. */
  it("writes no pairing secret to disk", async () => {
    const fixture = await startFixture({ remote: true });
    const cookies = await joinAs(fixture, "full", "MacBook Pro");
    const secret = /fleet_console_pairing_\d+=([^;]+)/u.exec(cookies)?.[1];
    expect(secret).toBeTruthy();

    const stored = fs.readFileSync(path.join(fixture.dir, "fleet-home", "console", "remote", "paired-devices.json"), "utf8");

    expect(stored).not.toContain(secret!);
    expect(JSON.parse(stored)).toMatchObject({ version: 1, devices: [{ device: "MacBook Pro", access: "full" }] });
  });
});

interface RemoteAccessStatus {
  readonly listener: { readonly listening: boolean; readonly origin: string | null; readonly lastError: string | null };
  readonly publicReachability: "unverified";
  readonly rejectedJoins: { readonly count: number; readonly lastAt: number | null };
  readonly fingerprint: string | null;
  readonly links: readonly { readonly id: string; readonly access: string; readonly issuedAt: number; readonly expiresAt: number }[];
  readonly devices: readonly { readonly id: string; readonly device: string | null; readonly access: string; readonly pairedAt: number; readonly lastSeenAt: number; readonly sessionHandle: string | null }[];
  readonly interfaces: readonly { readonly kind: string; readonly label: string; readonly address: string }[];
}

async function joinAs(fixture: Fixture, access: string, device: string): Promise<string> {
  const response = await fetch(`${fixture.loopbackEndpoint}api/v1/access-links?access=${access}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${fixture.lockToken}` },
  });
  const token = grantTokenOf((await response.json() as { link: string }).link);
  const joined = await remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token, device }));
  return cookiesOf(joined);
}

/**
 * 조인은 쿠키를 둘 실어 보낸다 — 접속을 가리키는 세션 쿠키와, 회수 전까지 사는 페어링 쿠키.
 * 앞의 하나만 집으면 재개 경로를 아예 시험할 수 없다.
 */
function cookiesOf(response: { readonly headers: import("node:http").IncomingHttpHeaders }): string {
  return (response.headers["set-cookie"] ?? []).map((entry) => entry.split(";")[0]!).join("; ");
}

/**
 * SSE를 읽는 최소 클라이언트. EventSource가 없는 환경이라 프레임을 직접 가른다 — 스트림은
 * 끝나지 않으므로 본문을 다 읽고 파싱하는 방식은 쓸 수 없다.
 */
interface EventProbe {
  waitFor(event: string, predicate: (data: any) => boolean, timeoutMs?: number): Promise<any>;
  seen(event: string): number;
  /** 서버가 이 스트림을 스스로 닫기를 기다린다. 자격을 잃은 구독이 남지 않았음의 증거다. */
  waitForClose(timeoutMs?: number): Promise<void>;
  close(): void;
}

function readEventStream(response: import("node:http").IncomingMessage): EventProbe {
  const received: Array<{ readonly event: string; readonly data: unknown }> = [];
  const waiters: Array<() => void> = [];
  let buffer = "";
  let closed = false;
  const markClosed = () => {
    closed = true;
    while (waiters.length > 0) waiters.pop()!();
  };
  response.on("end", markClosed);
  response.on("close", markClosed);
  response.setEncoding("utf8");
  response.on("data", (chunk: string) => {
    buffer += chunk;
    let split = buffer.indexOf("\n\n");
    while (split !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const event = /^event: (.+)$/mu.exec(frame)?.[1];
      const raw = /^data: (.*)$/mu.exec(frame)?.[1];
      if (event && raw !== undefined) {
        try {
          received.push({ event, data: JSON.parse(raw) });
        } catch {
          // 프레임이 깨졌으면 그 프레임만 버린다.
        }
      }
      while (waiters.length > 0) waiters.pop()!();
      split = buffer.indexOf("\n\n");
    }
  });
  return {
    seen: (event) => received.filter((entry) => entry.event === event).length,
    async waitFor(event, predicate, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = received.find((entry) => entry.event === event && predicate(entry.data));
        if (hit) return hit.data;
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${event}`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 50);
        });
      }
    },
    async waitForClose(timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (!closed) {
        if (Date.now() >= deadline) throw new Error("timed out waiting for the server to close the stream");
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 50);
        });
      }
    },
    close: () => response.destroy(),
  };
}

function openLoopbackEvents(fixture: Fixture): Promise<EventProbe> {
  const url = new URL(`${fixture.loopbackEndpoint}api/v1/operations/events`);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: url.hostname, port: Number(url.port), path: url.pathname, method: "GET" }, (response) => resolve(readEventStream(response)));
    request.on("error", reject);
    request.end();
  });
}

function openRemoteEvents(fixture: Fixture, cookie: string): Promise<EventProbe> {
  return new Promise((resolve, reject) => {
    const request = https.request({
      host: BIND_HOST,
      port: fixture.remotePort,
      path: "/api/v1/operations/events",
      method: "GET",
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
      headers: { host: `${BIND_HOST}:${fixture.remotePort}`, cookie },
    }, (response) => resolve(readEventStream(response)));
    request.on("error", reject);
    request.end();
  });
}

async function revoke(fixture: Fixture, resource: string): Promise<number> {
  const origin = fixture.loopbackEndpoint.replace(/\/$/u, "");
  const response = await fetch(`${origin}/api/v1/${resource}`, { method: "DELETE", headers: { Origin: origin } });
  return response.status;
}

async function readRemoteStatus(fixture: Fixture): Promise<RemoteAccessStatus> {
  return readRemoteStatusAt(fixture.loopbackEndpoint);
}

async function readRemoteStatusAt(loopbackEndpoint: string): Promise<RemoteAccessStatus> {
  const response = await fetch(`${loopbackEndpoint}api/v1/access-links`);
  return await response.json() as RemoteAccessStatus;
}

async function reservePort(host: string): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, host, () => { probe.off("error", reject); resolve(); });
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function saveRemoteAccess(fixture: Fixture, input: { readonly enabled: boolean; readonly bindHost: string }): Promise<void> {
  const remoteAccess = remoteSettings(input.enabled, input.bindHost, fixture.remotePort);
  await putRemoteAccess(fixture, remoteAccess);
  // 저장 응답은 리스너 전환이 끝난 뒤에 온다. 곧바로 읽은 상태가 이미 확정이어야 한다.
  const status = await readRemoteStatus(fixture);
  expect(status.listener.listening).toBe(remoteAccess.enabled && status.listener.lastError === null);
}

async function putRemoteAccess(fixture: Fixture, remoteAccess: ConsoleRemoteAccessSettings): Promise<void> {
  const origin = fixture.loopbackEndpoint.replace(/\/$/u, "");
  const response = await fetch(`${origin}/api/v1/settings/global`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ remoteAccess }),
  });
  if (!response.ok) throw new Error(`settings save failed: ${response.status} ${await response.text()}`);
}

function grantTokenOf(link: string): string {
  return parseAccessLink(link).token;
}

async function createLink(fixture: Fixture): Promise<string> {
  const response = await fetch(`${fixture.loopbackEndpoint}api/v1/access-links`, {
    method: "POST",
    headers: { Authorization: `Bearer ${fixture.lockToken}` },
  });
  return (await response.json() as { link: string }).link;
}

function readPresentedCertificateFingerprint(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = https.request({ host: BIND_HOST, port, path: "/api/v1/join", method: "POST", rejectUnauthorized: false }, (response) => {
      response.resume();
      resolve((request.socket as import("node:tls").TLSSocket).getPeerCertificate().fingerprint256);
    });
    request.on("error", reject);
    request.end();
  });
}

function remoteRequest(
  fixture: Fixture,
  method: string,
  requestPath: string,
  body?: string,
  cookie?: string,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = https.request({
      host: BIND_HOST,
      port: fixture.remotePort,
      path: requestPath,
      method,
      // 링크가 실어 나른 지문으로 서버를 확인한다 — CA 신뢰가 아니라 핀이다.
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
      headers: {
        host: `${BIND_HOST}:${fixture.remotePort}`,
        ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}),
        ...(cookie ? { cookie } : {}),
        ...extraHeaders,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function remoteRequestBody(
  fixture: Fixture,
  method: string,
  requestPath: string,
  /** Host를 위조한 요청을 보내기 위한 자리 — 게이트가 헤더를 믿지 않는지 확인한다. */
  hostHeader?: string,
  cookie?: string,
): Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = https.request({
      host: BIND_HOST,
      port: fixture.remotePort,
      path: requestPath,
      method,
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
      headers: {
        host: hostHeader ?? `${BIND_HOST}:${fixture.remotePort}`,
        ...(cookie ? { cookie } : {}),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}

function remoteSettings(enabled: boolean, host: string, port: number) {
  return {
    enabled,
    publicEndpointEnabled: true,
    listenAddress: host,
    advertisedHost: host,
    listenPort: { mode: "custom" as const, value: port },
    advertisedPort: { mode: "custom" as const, value: port },
    acknowledgment: enabled ? { version: 1 as const, listenAddress: host, listenPort: port, advertisedHost: host, advertisedPort: port } : null,
  };
}

async function startFixture(options: { readonly remote: boolean; readonly bindHost?: string; readonly remoteAccess?: ConsoleRemoteAccessSettings; readonly remoteRandomInt?: (min: number, maxExclusive: number) => number; readonly release?: ConsoleServerDeps["release"]; readonly updateCheck?: ConsoleServerDeps["updateCheck"]; readonly updateApply?: ConsoleServerDeps["updateApply"] }): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-remote-"));
  const dataRoot = path.join(dir, "fleet-home");
  tempDirs.push(dir);
  // durable state는 dataDir 아래 console/ 슬롯에 co-locate된다.
  const consoleDataDir = path.join(dataRoot, "console");
  if (options.remote) {
    fs.mkdirSync(consoleDataDir, { recursive: true });
    let remoteAccess = options.remoteAccess;
    if (!remoteAccess) {
      const host = options.bindHost ?? BIND_HOST;
      // Desktop이 :50000을 점유하면 고정 기본 포트가 custom_port_unavailable로 연쇄 실패한다.
      // 바인드 가능한 호스트만 예약하고, 의도적 불가 주소(예: 203.0.113.9)는 기존 50_000을 유지한다.
      const port = host === BIND_HOST ? await reservePort(BIND_HOST) : 50_000;
      remoteAccess = remoteSettings(true, host, port);
    }
    fs.writeFileSync(
      path.join(consoleDataDir, "settings.json"),
      JSON.stringify({ version: 1, general: { remoteAccess }, plugins: {} }),
    );
  }
  return bootFixture(dir, dataRoot, consoleDataDir, options.remote, options.remoteRandomInt, options);
}

/**
 * 프로세스 재기동을 흉내 낸다 — 같은 데이터 디렉터리에 서버를 새로 세운다. 살아 있는 서버의
 * 설정만 껐다 켜는 것과 달리 콘솔 포트가 다시 뽑히고, 디스크에 남은 것만으로 원격이 복원된다.
 */
async function restartFixture(fixture: Fixture): Promise<Fixture> {
  await stopFixture(fixture);
  return bootFixtureFrom(fixture);
}

/** 재기동을 두 걸음으로 가른다 — 그사이에 포트가 비는 순간을 시험이 쓸 수 있게. */
async function stopFixture(fixture: Fixture): Promise<void> {
  const index = servers.findIndex((entry) => entry === fixture.server);
  if (index !== -1) await servers.splice(index, 1)[0]!.stop();
}

function bootFixtureFrom(fixture: Fixture): Promise<Fixture> {
  const dataRoot = path.join(fixture.dir, "fleet-home");
  return bootFixture(fixture.dir, dataRoot, path.join(dataRoot, "console"), true);
}

async function bootFixture(dir: string, dataRoot: string, consoleDataDir: string, remote: boolean, remoteRandomInt?: (min: number, maxExclusive: number) => number, updateDeps: Pick<ConsoleServerDeps, "release" | "updateCheck" | "updateApply"> = {}): Promise<Fixture> {
  const server = createConsoleServer({
    port: 0,
    version: "test",
    agentRuntime: createFakeConsoleRuntime() as never,
    dataDir: dataRoot,
    systemFonts: { getFonts: async () => [] },
    remoteRandomInt,
    ...(updateDeps.release ? { release: updateDeps.release } : {}),
    ...(updateDeps.updateCheck ? { updateCheck: updateDeps.updateCheck } : {}),
    ...(updateDeps.updateApply ? { updateApply: updateDeps.updateApply } : {}),
  });
  servers.push(server);
  const loopbackEndpoint = await server.start({ dir, lockFile: path.join(dir, "console.lock") });
  const lock = createConsoleLock().readLock(path.join(dir, "console.lock"))!;
  const certificateFile = path.join(consoleDataDir, "remote", "identity-cert.pem");
  const fingerprint = remote && fs.existsSync(certificateFile)
    ? new crypto.X509Certificate(fs.readFileSync(certificateFile, "utf8")).fingerprint256
    : "";
  /**
   * 원격 포트는 콘솔 포트를 따라가지 않는다 — 처음 열린 포트를 계속 연다. 그러니 테스트도
   * lock의 포트가 아니라 리스너가 실제로 공표한 origin에서 읽어야 한다.
   */
  const base = { dir, server, loopbackEndpoint, lockToken: lock.token, fingerprint };
  if (!remote) return { ...base, remotePort: lock.port };
  const status = await readRemoteStatusAt(loopbackEndpoint);
  const published = status.listener.origin === null ? null : Number(new URL(status.listener.origin).port);
  return { ...base, remotePort: published ?? lock.port };
}

function createFakeConsoleRuntime(): unknown {
  const handlers = new Set<(event: unknown) => void>();
  return {
    carrierRuntime: { jobs: { streaming: { register(callback: (event: unknown) => void) { handlers.add(callback); return () => handlers.delete(callback); } } } },
    cleanup: vi.fn(async () => undefined),
  };
}
