import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentCliDetector } from "../../fleet-plugins/terminal/server/agent-api/agent-cli-detect.js";
import { createConsoleLock } from "../core/host/lock.js";
import { normalizeFingerprint } from "../core/host/remote-identity.js";
import { parseAccessLink } from "../core/host/access-link.js";
import { createConsoleServer, type ConsoleServer } from "../core/host/server.js";

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

  it("keeps the address inside the envelope so the link itself never shows it", async () => {
    const fixture = await startFixture({ remote: true });
    const link = await createLink(fixture);

    expect(link.startsWith("fleet://join?code=")).toBe(true);
    expect(link).not.toContain(BIND_HOST);
    expect(link).not.toContain(String(fixture.remotePort));
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

  it("refuses a remote grant presented to the loopback listener", async () => {
    const fixture = await startFixture({ remote: true });
    const token = grantTokenOf(await createLink(fixture));

    const joined = await fetch(`${fixture.loopbackEndpoint}api/v1/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });

    expect(joined.status).toBe(401);
  });

  it("opens and closes the remote listener when the setting changes, without a restart", async () => {
    const fixture = await startFixture({ remote: false });

    await expect(readRemoteStatus(fixture)).resolves.toMatchObject({ listening: false, origin: null, fingerprint: null });

    await saveRemoteAccess(fixture, { enabled: true, bindHost: BIND_HOST });
    const enabled = await readRemoteStatus(fixture);
    expect(enabled).toMatchObject({ listening: true, origin: `https://${BIND_HOST}:${fixture.remotePort}` });
    const token = grantTokenOf(await createLink(fixture));
    await expect(remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token }))).resolves.toMatchObject({ status: 204 });

    await saveRemoteAccess(fixture, { enabled: false, bindHost: BIND_HOST });
    await expect(readRemoteStatus(fixture)).resolves.toMatchObject({ listening: false, fingerprint: null });
    await expect(remoteRequest(fixture, "GET", "/api/v1/theaters")).rejects.toThrow();
  });

  it("kills the sessions a closed remote listener issued instead of leaving them redeemable", async () => {
    const fixture = await startFixture({ remote: true });
    const joined = await remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token: grantTokenOf(await createLink(fixture)) }));
    const session = (joined.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
    await expect(remoteRequest(fixture, "GET", "/api/v1/theaters", undefined, session)).resolves.toMatchObject({ status: 200 });

    await saveRemoteAccess(fixture, { enabled: false, bindHost: BIND_HOST });
    await saveRemoteAccess(fixture, { enabled: true, bindHost: BIND_HOST });

    await expect(remoteRequest(fixture, "GET", "/api/v1/theaters", undefined, session)).resolves.toMatchObject({ status: 401 });
  });

  it("reports a bind failure as a code instead of taking the console down", async () => {
    const fixture = await startFixture({ remote: false });

    await saveRemoteAccess(fixture, { enabled: true, bindHost: "203.0.113.7" });

    await expect(readRemoteStatus(fixture)).resolves.toMatchObject({ listening: false, lastError: "bind_address_unavailable" });
    await expect(fetch(`${fixture.loopbackEndpoint}api/v1/theaters`).then((r) => r.status)).resolves.toBe(200);
  });

  it("lists issued links and open sessions without ever re-serving a credential", async () => {
    const fixture = await startFixture({ remote: true });
    const first = await createLink(fixture);
    const second = await createLink(fixture);

    const listed = await readRemoteStatus(fixture);
    expect(listed.links).toHaveLength(2);
    // 목록을 보는 것만으로 어떤 링크도 다시 쓸 수 없어야 한다.
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain(grantTokenOf(first));
    expect(serialized).not.toContain(grantTokenOf(second));

    await remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token: grantTokenOf(first) }));
    const afterJoin = await readRemoteStatus(fixture);
    expect(afterJoin.links).toHaveLength(1);
    expect(afterJoin.sessions).toHaveLength(1);
    expect(JSON.stringify(afterJoin.sessions)).not.toContain("fleet_console_session");
  });

  it("revokes one unused link and leaves the others usable", async () => {
    const fixture = await startFixture({ remote: true });
    const doomed = await createLink(fixture);
    const kept = await createLink(fixture);
    const ids = (await readRemoteStatus(fixture)).links.map((link) => link.id);
    expect(ids).toHaveLength(2);

    // 어느 id가 어느 링크인지는 밖에서 알 수 없으므로, 하나를 지우고 둘 중 하나만 남는지 본다.
    await expect(revoke(fixture, `access-links/${ids[0]!}`)).resolves.toBe(204);
    await expect(revoke(fixture, `access-links/${ids[0]!}`)).resolves.toBe(404);
    expect((await readRemoteStatus(fixture)).links).toHaveLength(1);

    const outcomes = await Promise.all([doomed, kept].map(async (link) =>
      (await remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token: grantTokenOf(link) }))).status));
    expect(outcomes.filter((status) => status === 204)).toHaveLength(1);
    expect(outcomes.filter((status) => status === 401)).toHaveLength(1);
  });

  it("ends one open session immediately", async () => {
    const fixture = await startFixture({ remote: true });
    const joined = await remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token: grantTokenOf(await createLink(fixture)) }));
    const cookie = (joined.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
    const handle = (await readRemoteStatus(fixture)).sessions[0]!.handle;

    await expect(revoke(fixture, `access-sessions/${handle}`)).resolves.toBe(204);

    await expect(remoteRequest(fixture, "GET", "/api/v1/theaters", undefined, cookie)).resolves.toMatchObject({ status: 401 });
    expect((await readRemoteStatus(fixture)).sessions).toHaveLength(0);
  });

  it("rotates the identity and takes every link, session, and pin with it", async () => {
    const fixture = await startFixture({ remote: true });
    const staleLink = await createLink(fixture);
    const joined = await remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token: grantTokenOf(await createLink(fixture)) }));
    const staleCookie = (joined.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
    const before = await readRemoteStatus(fixture);

    const rotated = await fetch(`${fixture.loopbackEndpoint}api/v1/remote-identity/rotations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.lockToken}` },
    });
    expect(rotated.status).toBe(200);

    const after = await readRemoteStatus(fixture);
    expect(after.listening).toBe(true);
    expect(normalizeFingerprint(after.fingerprint!)).not.toBe(normalizeFingerprint(before.fingerprint!));
    expect(after.links).toHaveLength(0);
    expect(after.sessions).toHaveLength(0);
    // 새 인증서를 실제로 제시해야 한다 — 상태만 바뀌고 리스너가 옛 키를 쓰면 핀이 어긋난다.
    expect(normalizeFingerprint(await readPresentedCertificateFingerprint(fixture.remotePort))).toBe(normalizeFingerprint(after.fingerprint!));
    await expect(remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token: grantTokenOf(staleLink) }))).resolves.toMatchObject({ status: 401 });
    await expect(remoteRequest(fixture, "GET", "/api/v1/theaters", undefined, staleCookie)).resolves.toMatchObject({ status: 401 });
  });

  /**
   * Codex 게이트웨이는 자기만의 Host 검사만 한다. 원격 판정이 그 분기 뒤에 있으면 세션 없는
   * 요청이 `Host: 127.0.0.1:<port>` 하나로 원격 리스너를 통과해 Wiki 내용을 받아 간다.
   */
  it("refuses a session-less Codex request that forges the loopback Host", async () => {
    const fixture = await startFixture({ remote: true });

    for (const target of ["/console/codex", "/console/codex/", "/console/codex/api/search?q=a"]) {
      const forged = await remoteRequestBody(fixture, "GET", target, `127.0.0.1:${fixture.remotePort}`);
      expect({ target, status: forged.status }).toEqual({ target, status: 401 });
    }
  });

  /**
   * 저장된 주소는 어제 붙어 있던 인터페이스의 것이다. 그 주소가 사라졌을 때 기동까지 함께
   * 무너지면, 사용자는 설정을 고칠 화면조차 열 수 없다.
   */
  it("still starts the console when the saved remote address no longer exists", async () => {
    // TEST-NET-3. 이 기계에 있을 수 없는 주소라 바인드는 반드시 실패한다.
    const fixture = await startFixture({ remote: true, bindHost: "203.0.113.9" });

    const status = await fetch(`${fixture.loopbackEndpoint}api/v1/access-links`, {
      headers: { Authorization: `Bearer ${fixture.lockToken}` },
    }).then((response) => response.json() as Promise<{ listening: boolean; lastError: string | null }>);

    expect(fixture.loopbackEndpoint).toContain("127.0.0.1");
    expect(status.listening).toBe(false);
    expect(status.lastError).not.toBeNull();
  });

  it("answers a browser that typed the address with an explanation instead of a bare 401", async () => {
    const fixture = await startFixture({ remote: true });

    const notice = await remoteRequestBody(fixture, "GET", "/join");

    expect(notice.status).toBe(200);
    expect(notice.headers["content-type"]).toContain("text/html");
    // 막다른 길에서 끝내지 않고, 링크의 모양과 그것을 붙여넣을 자리를 함께 알려 준다.
    expect(notice.body).toContain("fleet://join?code=");
    expect(notice.body).toContain("Remote access");
    // 설명만 하고 아무것도 하지 않는 문서여야 한다.
    expect(notice.body).not.toMatch(/<script|\bon[a-z]+=/iu);
    expect(notice.headers["content-security-policy"]).toContain("default-src 'none'");
    // 나머지 표면은 그대로 닫혀 있다.
    await expect(remoteRequest(fixture, "GET", "/console/")).resolves.toMatchObject({ status: 401 });
    await expect(remoteRequest(fixture, "POST", "/join")).resolves.toMatchObject({ status: 401 });
  });

  it("holds a monitoring session to reading, and lets a full one through", async () => {
    const fixture = await startFixture({ remote: true });
    const watcher = await joinAs(fixture, "monitoring", "iPad");
    const operator = await joinAs(fixture, "full", "MacBook Pro");

    // 등급이 사고 후 범위를 좁히려면 쓰기가 실제로 막혀야 한다.
    await expect(remoteRequest(fixture, "GET", "/api/v1/theaters", undefined, watcher)).resolves.toMatchObject({ status: 200 });
    await expect(remoteRequest(fixture, "POST", "/api/v1/theaters", "{}", watcher)).resolves.toMatchObject({ status: 401 });
    await expect(remoteRequest(fixture, "POST", "/api/v1/theaters", "{}", operator)).resolves.not.toMatchObject({ status: 401 });

    const listed = await readRemoteStatus(fixture);
    expect(listed.sessions.map((entry) => [entry.device, entry.access]).sort()).toEqual([["MacBook Pro", "full"], ["iPad", "monitoring"]].sort());
  });

  it("refuses a websocket upgrade from a monitoring session even though the method reads", async () => {
    const fixture = await startFixture({ remote: true });
    const watcher = await joinAs(fixture, "monitoring", "iPad");

    const upgraded = await remoteRequest(fixture, "GET", "/api/v1/theaters", undefined, watcher, { upgrade: "websocket" });

    expect(upgraded.status).toBe(401);
  });

  it("reports the addresses this machine can actually listen on", async () => {
    const fixture = await startFixture({ remote: false });

    const status = await readRemoteStatus(fixture);

    expect(status.interfaces.length).toBeGreaterThan(0);
    expect(status.interfaces.every((entry) => /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(entry.address))).toBe(true);
    expect(status.interfaces.some((entry) => entry.address === BIND_HOST)).toBe(true);
    expect(status.interfaces.every((entry) => entry.kind === "tailscale" || entry.kind === "local")).toBe(true);
  });

  it("keeps the loopback listener open without a session", async () => {
    const fixture = await startFixture({ remote: true });

    await expect(fetch(`${fixture.loopbackEndpoint}api/v1/theaters`).then((r) => r.status)).resolves.toBe(200);
  });
});

interface RemoteAccessStatus {
  readonly listening: boolean;
  readonly origin: string | null;
  readonly fingerprint: string | null;
  readonly lastError: string | null;
  readonly links: readonly { readonly id: string; readonly access: string; readonly issuedAt: number; readonly expiresAt: number }[];
  readonly sessions: readonly { readonly handle: string; readonly device: string | null; readonly access: string; readonly openedAt: number; readonly expiresAt: number }[];
  readonly interfaces: readonly { readonly kind: string; readonly label: string; readonly address: string }[];
}

async function joinAs(fixture: Fixture, access: string, device: string): Promise<string> {
  const response = await fetch(`${fixture.loopbackEndpoint}api/v1/access-links?access=${access}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${fixture.lockToken}` },
  });
  const token = grantTokenOf((await response.json() as { link: string }).link);
  const joined = await remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token, device }));
  return (joined.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
}

async function revoke(fixture: Fixture, resource: string): Promise<number> {
  const origin = fixture.loopbackEndpoint.replace(/\/$/u, "");
  const response = await fetch(`${origin}/api/v1/${resource}`, { method: "DELETE", headers: { Origin: origin } });
  return response.status;
}

async function readRemoteStatus(fixture: Fixture): Promise<RemoteAccessStatus> {
  const response = await fetch(`${fixture.loopbackEndpoint}api/v1/access-links`);
  return await response.json() as RemoteAccessStatus;
}

async function saveRemoteAccess(fixture: Fixture, remoteAccess: { readonly enabled: boolean; readonly bindHost: string }): Promise<void> {
  const origin = fixture.loopbackEndpoint.replace(/\/$/u, "");
  const response = await fetch(`${origin}/api/v1/settings/global`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ remoteAccess }),
  });
  if (!response.ok) throw new Error(`settings save failed: ${response.status} ${await response.text()}`);
  // 저장 응답은 리스너 전환이 끝난 뒤에 온다. 곧바로 읽은 상태가 이미 확정이어야 한다.
  const status = await readRemoteStatus(fixture);
  expect(status.listening).toBe(remoteAccess.enabled && status.lastError === null);
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
): Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders }> {
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
      response.resume();
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers }));
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
): Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = https.request({
      host: BIND_HOST,
      port: fixture.remotePort,
      path: requestPath,
      method,
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
      headers: { host: hostHeader ?? `${BIND_HOST}:${fixture.remotePort}` },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}

async function startFixture(options: { readonly remote: boolean; readonly bindHost?: string }): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-remote-"));
  const dataRoot = path.join(dir, "fleet-home");
  tempDirs.push(dir);
  // durable state는 dataDir 아래 console/ 슬롯에 co-locate된다.
  const consoleDataDir = path.join(dataRoot, "console");
  if (options.remote) {
    fs.mkdirSync(consoleDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(consoleDataDir, "settings.json"),
      JSON.stringify({ version: 1, general: { remoteAccess: { enabled: true, bindHost: options.bindHost ?? BIND_HOST } }, plugins: {} }),
    );
  }
  const server = createConsoleServer({
    port: 0,
    version: "test",
    agentRuntime: createFakeConsoleRuntime() as never,
    agentCliDetector: { detect: async () => [] } satisfies AgentCliDetector,
    dataDir: dataRoot,
    systemFonts: { getFonts: async () => [] },
  });
  servers.push(server);
  const loopbackEndpoint = await server.start({ dir, lockFile: path.join(dir, "console.lock") });
  const lock = createConsoleLock().readLock(path.join(dir, "console.lock"))!;
  const certificateFile = path.join(consoleDataDir, "remote", "identity-cert.pem");
  const fingerprint = options.remote && fs.existsSync(certificateFile)
    ? new crypto.X509Certificate(fs.readFileSync(certificateFile, "utf8")).fingerprint256
    : "";
  return { dir, loopbackEndpoint, remotePort: lock.port, lockToken: lock.token, fingerprint };
}

function createFakeConsoleRuntime(): unknown {
  const handlers = new Set<(event: unknown) => void>();
  return {
    carrierRuntime: { jobs: { streaming: { register(callback: (event: unknown) => void) { handlers.add(callback); return () => handlers.delete(callback); } } } },
    cleanup: vi.fn(async () => undefined),
  };
}
