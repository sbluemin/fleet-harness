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

  // 오타가 조용히 넓은 등급으로 떨어지면, 좁히려고 고른 값이 좁히지 못한 채 링크가 나간다.
  it("refuses an access class it does not recognise instead of widening it to full", async () => {
    const fixture = await startFixture({ remote: true });

    const response = await fetch(`${fixture.loopbackEndpoint}api/v1/access-links?access=monitorring`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.lockToken}` },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_access_class" });
    expect((await readRemoteStatus(fixture)).links).toHaveLength(0);
  });

  it("still issues a full link when no class is named", async () => {
    const fixture = await startFixture({ remote: true });

    const response = await fetch(`${fixture.loopbackEndpoint}api/v1/access-links`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.lockToken}` },
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ access: "full" });
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

  it("stops even while a remote device is still holding a connection", async () => {
    /**
     * 원격 창은 스스로 연결을 끊지 않는다. 리스너를 `close()`만 하고 소켓을 남기면 그 종료는
     * 영영 끝나지 않고, 프로세스도 락도 그대로 남는다 — 업데이트 워커는 그 락이 사라지기를
     * 기다리다 시간 초과로 실패한다. 원격 업데이트가 통째로 불가능해지는 지점이다.
     */
    const fixture = await startFixture({ remote: true });
    const held = tls.connect({
      host: BIND_HOST,
      port: fixture.remotePort,
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
    });
    await new Promise<void>((resolve, reject) => {
      held.once("secureConnect", () => resolve());
      held.once("error", reject);
    });
    // 요청을 보내지 않고 붙잡고만 있는다 — 받아들여진 채 쉬고 있는 연결이 바로 close()를
    // 붙드는 것이고, 원격 창이 스트림 사이에서 취하는 상태다.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const stopped = await Promise.race([
      stopFixture(fixture).then(() => "stopped" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 5_000)),
    ]);
    held.destroy();

    expect(stopped).toBe("stopped");
  });

  it("makes a remote hand read what it is doing before it takes the host down", async () => {
    /**
     * 원격에서 누른 손은 이 기계 앞에 없다. 이 콘솔을 내리는 일은 그 자리에 앉아 있는 사람의
     * 화면까지 함께 내리므로, 원격 리스너로 들어온 요청은 그 사실을 읽고 나서만 진행한다.
     * 보안 관문이 아니라 고의성의 표식이다 — 관문은 이미 세션이 지켰다.
     */
    const updateApplyStart = vi.fn().mockResolvedValue({ accepted: true });
    const fixture = await startFixture({
      remote: true,
      release: { channel: "stable", version: "1.0.0", packageRoot: "/pkg" },
      updateApply: { start: updateApplyStart },
      updateCheck: {
        getStatus: () => ({ updateAvailable: true, latestVersion: "1.2.3" }),
        refresh: async () => ({ updateAvailable: true, latestVersion: "1.2.3" }),
      },
    });
    const joined = await remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token: grantTokenOf(await createLink(fixture)) }));
    const session = cookiesOf(joined);
    const origin = `https://${BIND_HOST}:${fixture.remotePort}`;

    const unconfirmed = await remoteRequest(fixture, "POST", "/api/v1/updates/apply", JSON.stringify({}), session, { origin });
    expect(unconfirmed.status).toBe(409);
    expect(JSON.parse(unconfirmed.body)).toEqual({ error: "host_restart_confirmation_required" });
    expect(updateApplyStart).not.toHaveBeenCalled();

    const confirmed = await remoteRequest(fixture, "POST", "/api/v1/updates/apply", JSON.stringify({ acknowledgeHostRestart: true }), session, { origin });
    expect(confirmed.status).toBe(202);
    expect(updateApplyStart).toHaveBeenCalledOnce();
  });

  it("asks the hand at the machine for no such confirmation", async () => {
    const updateApplyStart = vi.fn().mockResolvedValue({ accepted: true });
    const fixture = await startFixture({
      remote: true,
      release: { channel: "stable", version: "1.0.0", packageRoot: "/pkg" },
      updateApply: { start: updateApplyStart },
      updateCheck: {
        getStatus: () => ({ updateAvailable: true, latestVersion: "1.2.3" }),
        refresh: async () => ({ updateAvailable: true, latestVersion: "1.2.3" }),
      },
    });

    const response = await fetch(`${fixture.loopbackEndpoint}api/v1/updates/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: new URL(fixture.loopbackEndpoint).origin },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(202);
    expect(updateApplyStart).toHaveBeenCalledOnce();
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

    await expect(readRemoteStatus(fixture)).resolves.toMatchObject({ listener: { listening: false, origin: null }, fingerprint: null });

    await saveRemoteAccess(fixture, { enabled: true, bindHost: BIND_HOST });
    const enabled = await readRemoteStatus(fixture);
    expect(enabled).toMatchObject({ listener: { listening: true, origin: `https://${BIND_HOST}:${fixture.remotePort}` } });
    const token = grantTokenOf(await createLink(fixture));
    await expect(remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token }))).resolves.toMatchObject({ status: 204 });

    await saveRemoteAccess(fixture, { enabled: false, bindHost: BIND_HOST });
    await expect(readRemoteStatus(fixture)).resolves.toMatchObject({ listener: { listening: false }, fingerprint: null });
    await expect(remoteRequest(fixture, "GET", "/api/v1/theaters")).rejects.toThrow();
  });

  it("revokes unused links on an explicit disable while preserving pairings", async () => {
    const fixture = await startFixture({ remote: true });
    await joinAs(fixture, "monitoring", "paired-device");
    await createLink(fixture);
    expect((await readRemoteStatus(fixture)).links).toHaveLength(1);
    expect((await readRemoteStatus(fixture)).devices).toHaveLength(1);

    await saveRemoteAccess(fixture, { enabled: false, bindHost: BIND_HOST });
    const disabled = await readRemoteStatus(fixture);
    expect(disabled.links).toHaveLength(0);
    expect(disabled.devices).toHaveLength(1);
  });

  it("uses the listen tuple for LAN-only links, TLS identity, Host checks, and persisted advertised port", async () => {
    const port = await reservePort(BIND_HOST);
    const remoteAccess: ConsoleRemoteAccessSettings = {
      enabled: true,
      publicEndpointEnabled: false,
      listenAddress: BIND_HOST,
      advertisedHost: "public-draft.example",
      listenPort: { mode: "custom", value: port },
      advertisedPort: { mode: "custom", value: 443 },
      acknowledgment: null,
    };
    const fixture = await startFixture({ remote: true, remoteAccess });
    const parsed = parseAccessLink(await createLink(fixture));
    const certificate = new crypto.X509Certificate(fs.readFileSync(path.join(fixture.dir, "fleet-home", "console", "remote", "identity-cert.pem"), "utf8"));
    const savedEndpoint = JSON.parse(fs.readFileSync(path.join(fixture.dir, "fleet-home", "console", "remote", "listener.json"), "utf8")) as { advertisedPort: number };

    expect(parsed.origin).toBe(`https://${BIND_HOST}:${port}`);
    expect(certificate.subjectAltName).toContain(`IP Address:${BIND_HOST}`);
    expect(savedEndpoint.advertisedPort).toBe(port);
    const joined = await remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token: grantTokenOf(await createLink(fixture)) }));
    await expect(remoteRequest(fixture, "GET", "/api/v1/theaters", undefined, cookiesOf(joined), { host: `public-draft.example:443` })).resolves.toMatchObject({ status: 403 });
  });

  it("keeps credentials when a disabled LAN-only public draft changes", async () => {
    const fixture = await startFixture({ remote: true });
    await joinAs(fixture, "monitoring", "paired-device");
    await createLink(fixture);
    const lanOnly = { ...remoteSettings(false, BIND_HOST, fixture.remotePort), publicEndpointEnabled: false, acknowledgment: null };
    await putRemoteAccess(fixture, lanOnly);
    const before = await readRemoteStatus(fixture);

    await putRemoteAccess(fixture, { ...lanOnly, advertisedHost: "unused-public.example", advertisedPort: { mode: "custom", value: 443 } });

    const after = await readRemoteStatus(fixture);
    expect(after.links).toEqual(before.links);
    expect(after.devices).toEqual(before.devices);
  });

  it("treats a LAN-only listen tuple edit as a public identity change", async () => {
    const lanOnly = { ...remoteSettings(true, BIND_HOST, await reservePort(BIND_HOST)), publicEndpointEnabled: false, acknowledgment: null };
    const fixture = await startFixture({ remote: true, remoteAccess: lanOnly });
    await joinAs(fixture, "monitoring", "paired-device");
    await createLink(fixture);
    const before = await readRemoteStatus(fixture);
    expect(before).toMatchObject({ links: [expect.any(Object)], devices: [expect.any(Object)] });

    await putRemoteAccess(fixture, { ...lanOnly, enabled: false, listenPort: { mode: "custom", value: fixture.remotePort + 1 } });

    const after = await readRemoteStatus(fixture);
    expect(after.links).toHaveLength(0);
    expect(after.devices).toHaveLength(0);
  });

  it("preserves unused links and pairings when a public route keeps its effective tuple", async () => {
    const fixture = await startFixture({ remote: true });
    await joinAs(fixture, "monitoring", "paired-device");
    await createLink(fixture);
    const active = await readRemoteStatus(fixture);
    const remoteAccess = remoteSettings(false, BIND_HOST, fixture.remotePort);
    remoteAccess.listenPort = { mode: "custom", value: fixture.remotePort + 1 };
    remoteAccess.acknowledgment = null;

    await putRemoteAccess(fixture, remoteAccess);

    const stopped = await readRemoteStatus(fixture);
    expect(stopped.listener.listening).toBe(false);
    expect(stopped.links).toEqual(active.links);
    expect(stopped.devices).toHaveLength(1);
  });

  it("revokes links and pairings immediately for a public identity edit", async () => {
    const fixture = await startFixture({ remote: true });
    await joinAs(fixture, "monitoring", "paired-device");
    await createLink(fixture);
    const remoteAccess = remoteSettings(false, BIND_HOST, fixture.remotePort);
    remoteAccess.advertisedHost = "new-public.example";
    remoteAccess.acknowledgment = null;

    await putRemoteAccess(fixture, remoteAccess);

    const stopped = await readRemoteStatus(fixture);
    expect(stopped.listener.listening).toBe(false);
    expect(stopped.links).toHaveLength(0);
    expect(stopped.devices).toHaveLength(0);
  });

  it("revokes public credentials after a prior local edit already removed the active listener", async () => {
    const fixture = await startFixture({ remote: true });
    await joinAs(fixture, "monitoring", "paired-device");
    await createLink(fixture);
    const localEdit = remoteSettings(false, BIND_HOST, fixture.remotePort);
    localEdit.listenPort = { mode: "custom", value: fixture.remotePort + 1 };
    localEdit.acknowledgment = null;
    await putRemoteAccess(fixture, localEdit);
    expect((await readRemoteStatus(fixture))).toMatchObject({ links: [expect.any(Object)], devices: [expect.any(Object)] });

    const publicEdit = { ...localEdit, advertisedHost: "sequential-public.example" };
    await putRemoteAccess(fixture, publicEdit);

    const stopped = await readRemoteStatus(fixture);
    expect(stopped.listener.listening).toBe(false);
    expect(stopped.links).toHaveLength(0);
    expect(stopped.devices).toHaveLength(0);
  });

  it("revokes unused grants when a failed listener is explicitly disabled", async () => {
    const fixture = await startFixture({ remote: true });
    await createLink(fixture);
    const squatter = http.createServer();
    await new Promise<void>((resolve, reject) => {
      squatter.once("error", reject);
      squatter.listen(0, BIND_HOST, () => { squatter.off("error", reject); resolve(); });
    });
    try {
      const address = squatter.address();
      const occupiedPort = typeof address === "object" && address ? address.port : 0;
      const failed = remoteSettings(true, BIND_HOST, fixture.remotePort);
      failed.listenPort = { mode: "custom", value: occupiedPort };
      failed.acknowledgment = { ...failed.acknowledgment!, listenPort: occupiedPort };
      await putRemoteAccess(fixture, failed);
      expect((await readRemoteStatus(fixture))).toMatchObject({ listener: { listening: false, lastError: "custom_port_unavailable" }, links: [expect.any(Object)] });

      await putRemoteAccess(fixture, { ...failed, enabled: false, acknowledgment: null });

      expect((await readRemoteStatus(fixture)).links).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
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

    await expect(readRemoteStatus(fixture)).resolves.toMatchObject({ listener: { listening: false, lastError: "bind_address_unavailable" } });
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
    expect(afterJoin.devices).toHaveLength(1);
    expect(JSON.stringify(afterJoin.devices)).not.toContain("fleet_console_session");
    expect(JSON.stringify(afterJoin.devices)).not.toContain("fleet_console_pairing");
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

  it("ends one open session immediately while the pairing that opened it survives", async () => {
    const fixture = await startFixture({ remote: true });
    const joined = await remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token: grantTokenOf(await createLink(fixture)) }));
    const cookie = cookiesOf(joined);
    const handle = (await readRemoteStatus(fixture)).devices[0]!.sessionHandle!;

    await expect(revoke(fixture, `access-sessions/${handle}`)).resolves.toBe(204);

    await expect(remoteRequest(fixture, "GET", "/api/v1/theaters", undefined, cookie)).resolves.toMatchObject({ status: 401 });
    // 접속만 끊겼다. 그 기기는 여전히 이 콘솔의 손님이고 목록에 남는다.
    const after = await readRemoteStatus(fixture);
    expect(after.devices).toHaveLength(1);
    expect(after.devices[0]!.sessionHandle).toBeNull();
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
    expect(after.listener.listening).toBe(true);
    expect(normalizeFingerprint(after.fingerprint!)).not.toBe(normalizeFingerprint(before.fingerprint!));
    expect(after.links).toHaveLength(0);
    // 지문이 바뀌면 그 지문을 믿고 붙던 페어링도 더는 성립하지 않는다.
    expect(after.devices).toHaveLength(0);
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
   * 원격 리스너의 Host는 루프백 바인드 호스트가 아니다. Codex가 자기 게이트를 바인드 호스트에서만
   * 세우면, 세션을 정상적으로 연 사용자도 Wiki를 열 때마다 host_mismatch를 돌려받는다.
   */
  it("lets an admitted session reach Codex through the remote listener's own host", async () => {
    const fixture = await startFixture({ remote: true });
    const operator = await joinAs(fixture, "full", "MacBook Pro");

    // 등록되지 않은 workspace라 라우팅은 곧장 404로 끝난다 — 여기서 보는 것은 Host 게이트뿐이다.
    const reached = await remoteRequestBody(fixture, "GET", "/console/codex/w/absent/api/search", undefined, operator);
    // 자기 주소만 연다: 원격 리스너에 붙어 다른 호스트를 주장하는 요청은 그대로 막힌다.
    const foreign = await remoteRequestBody(fixture, "GET", "/console/codex/w/absent/api/search", `203.0.113.10:${fixture.remotePort}`, operator);

    expect(reached.status).toBe(404);
    expect(reached.body).toContain("workspace_not_found");
    expect(foreign.status).toBe(403);
    expect(foreign.body).toContain("host_mismatch");
  });

  /**
   * 그리고 그 Host의 포트도 원격 리스너의 것이다. 두 리스너가 늘 같은 포트를 쓰던 동안에는
   * 콘솔 포트로 대조해도 우연히 맞았지만, 재시작이 둘을 갈라 놓으면 그 우연이 끝난다.
   */
  it("keeps Codex reachable after a restart moves the console port away from the published one", async () => {
    const restarted = await restartFixture(await startFixture({ remote: true }));
    expect(restarted.remotePort).not.toBe(Number(new URL(restarted.loopbackEndpoint).port));
    const operator = await joinAs(restarted, "full", "MacBook Pro");

    const reached = await remoteRequestBody(restarted, "GET", "/console/codex/w/absent/api/search", undefined, operator);

    expect(reached.status).toBe(404);
    expect(reached.body).toContain("workspace_not_found");
  });

  /**
   * 읽기만 되는 것으로는 부족하다. 쓰기는 Host가 아니라 Origin으로 한 번 더 갈리는데, 그 판정도
   * 콘솔 포트를 보고 있었다 — 포트가 갈라지면 제어를 쥔 원격이 결재만 못 하는 상태가 된다.
   */
  it("keeps a Codex write reachable after that restart, not only a read", async () => {
    const restarted = await restartFixture(await startFixture({ remote: true }));
    const origin = `https://${BIND_HOST}:${restarted.remotePort}`;
    expect(origin).not.toBe(`https://${BIND_HOST}:${new URL(restarted.loopbackEndpoint).port}`);
    const operator = await joinAs(restarted, "full", "MacBook Pro");

    const decided = await remoteRequest(restarted, "POST", "/console/codex/api/drydock/2026-08-09T00-00-00-000Z-0123abcd/decision", "{}", operator, {
      origin,
      "content-type": "application/json",
    });

    /**
     * Origin 게이트를 지나 워크스페이스 판정까지 갔다는 것이 여기서 볼 것의 전부다.
     * 포트가 어긋나면 이 자리에 닿기 전에 `403 origin_mismatch`로 끝난다.
     *
     * 예전에는 콘솔이 `codexCwd`로 Theater 없는 기본 워크스페이스를 하나 들고 떠서 본문
     * 판정까지 갔다. Codex가 플러그인이 된 뒤로 워크스페이스는 Theater 등록의 결과이고,
     * 이 픽스처에는 Theater가 없다 — 그래서 판정은 "열린 워크스페이스가 없다"이다.
     */
    expect({ status: decided.status, body: decided.body })
      .toEqual({ status: 404, body: JSON.stringify({ error: "no_workspace_registered" }) });
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
    }).then((response) => response.json() as Promise<{ listener: { listening: boolean; lastError: string | null } }>);

    expect(fixture.loopbackEndpoint).toContain("127.0.0.1");
    expect(status.listener.listening).toBe(false);
    expect(status.listener.lastError).not.toBeNull();
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

  it("spends a failure budget on the unauthenticated join door and reports the rejections", async () => {
    const fixture = await startFixture({ remote: true });

    // 실패만 계수된다. 예산을 넘기면 본문을 읽기 전에 429로 끝나고 Retry-After를 실어 준다.
    let throttled: Awaited<ReturnType<typeof remoteRequest>> | null = null;
    for (let attempt = 0; attempt < 24 && throttled === null; attempt += 1) {
      const response = await remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token: `bad-${attempt}` }));
      if (response.status === 429) throttled = response;
    }

    expect(throttled).not.toBeNull();
    expect(throttled!.headers["retry-after"]).toBeDefined();
    expect(throttled!.body).toContain("too_many_attempts");

    // 조용히 막지 않는다 — 주인이 이 사실을 화면에서 볼 수 있어야 판단할 수 있다.
    const status = await readRemoteStatus(fixture);
    expect(status.rejectedJoins.count).toBeGreaterThan(0);
    expect(status.rejectedJoins.lastAt).not.toBeNull();
  });

  it("holds a monitoring session to reading, and lets a full one through", async () => {
    const fixture = await startFixture({ remote: true });
    const watcher = await joinAs(fixture, "monitoring", "iPad");

    // 등급이 사고 후 범위를 좁히려면 쓰기가 실제로 막혀야 한다.
    await expect(remoteRequest(fixture, "GET", "/api/v1/theaters", undefined, watcher)).resolves.toMatchObject({ status: 200 });
    await expect(remoteRequest(fixture, "POST", "/api/v1/theaters", "{}", watcher)).resolves.toMatchObject({ status: 401 });

    // 자리는 하나이므로 full은 관전자를 대신해서 들어온다. 등급은 그와 무관하게 각자의 것이다.
    const operator = await joinAs(fixture, "full", "MacBook Pro");
    await expect(remoteRequest(fixture, "POST", "/api/v1/theaters", "{}", operator)).resolves.not.toMatchObject({ status: 401 });

    const listed = await readRemoteStatus(fixture);
    expect(listed.devices.map((entry) => [entry.device, entry.access]).sort()).toEqual([["MacBook Pro", "full"], ["iPad", "monitoring"]].sort());
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

  /**
   * 초대받은 손님은 초대장을 관리하지 못한다. 이 목록에는 인증서 지문, 다른 기기의 이름,
   * 그리고 이 기계가 가진 모든 주소가 실려 있고, 이 쓰기들은 손님이 자기보다 오래 사는
   * 초대장을 새로 찍거나 남의 자리를 끊거나 호스트 신원을 통째로 갈아 끼우게 한다.
   */
  it("does not ship the remote access section to a remote session at all", async () => {
    const fixture = await startFixture({ remote: true });
    const cookie = await joinAs(fixture, "full", "guest");
    const asRemote = { origin: `https://${BIND_HOST}:${fixture.remotePort}` };

    const seen = await remoteRequest(fixture, "GET", "/api/v1/settings/global", undefined, cookie, asRemote);
    expect(seen.status).toBe(200);
    const remoteView = JSON.parse(seen.body) as Record<string, unknown>;
    // 이 기계의 LAN 주소는 초대받은 손님이 읽을 값이 아니다 — 관리 목록을 루프백에 둔 것과 같은 이유다.
    expect(remoteView).not.toHaveProperty("remoteAccess");
    expect(remoteView).toHaveProperty("theme");
    expect(JSON.stringify(remoteView)).not.toContain(BIND_HOST);

    // 원격이 쓴 응답도 같은 규칙을 따른다 — 한쪽만 가리면 왕복 한 번에 새어 나간다.
    const wrote = await remoteRequest(fixture, "PUT", "/api/v1/settings/global", JSON.stringify({ theme: "carbon" }), cookie, asRemote);
    expect(wrote.status).toBe(200);
    expect(JSON.parse(wrote.body).state).not.toHaveProperty("remoteAccess");

    // 루프백에서는 그대로 보인다.
    const owner = await fetch(`${fixture.loopbackEndpoint}api/v1/settings/global`, { headers: { Origin: fixture.loopbackEndpoint.replace(/\/$/u, "") } });
    expect(await owner.json()).toHaveProperty("remoteAccess");
  });

  it("refuses a remote session the listener's own settings, not just the access routes", async () => {
    const fixture = await startFixture({ remote: true });
    const cookie = await joinAs(fixture, "full", "guest");
    const asRemote = { origin: `https://${BIND_HOST}:${fixture.remotePort}` };

    // 공표 튜플을 바꾸면 신원이 교체되어 전 기기가 페어링 해제된다. 그 결과에 이르는 전용
    // 라우트가 401인데 이 문이 열려 있으면, 막아 둔 것은 이름뿐이다.
    const body = JSON.stringify({
      remoteAccess: {
        enabled: true, publicEndpointEnabled: true, listenAddress: BIND_HOST, advertisedHost: "attacker.example.com",
        listenPort: { mode: "custom", value: fixture.remotePort }, advertisedPort: { mode: "custom", value: 55553 },
        acknowledgment: { version: 1, listenAddress: BIND_HOST, listenPort: fixture.remotePort, advertisedHost: "attacker.example.com", advertisedPort: 55553 },
      },
    });
    await expect(remoteRequest(fixture, "PUT", "/api/v1/settings/global", body, cookie, asRemote)).resolves.toMatchObject({ status: 401 });

    // 원격 세션이 못 만지는 것은 이 섹션뿐이다 — 테마·글꼴까지 잠그면 원격 조작이 무의미해진다.
    await expect(remoteRequest(fixture, "PUT", "/api/v1/settings/global", JSON.stringify({ theme: "carbon" }), cookie, asRemote))
      .resolves.toMatchObject({ status: 200 });

    expect((await readRemoteStatus(fixture)).listener.origin).toBe(`https://${BIND_HOST}:${fixture.remotePort}`);
  });

  it("keeps remote access administration on the loopback side", async () => {
    const fixture = await startFixture({ remote: true });
    const cookie = await joinAs(fixture, "full", "guest");
    const remoteOrigin = `https://${BIND_HOST}:${fixture.remotePort}`;
    const asRemote = { origin: remoteOrigin };

    await expect(remoteRequest(fixture, "GET", "/api/v1/access-links", undefined, cookie, asRemote)).resolves.toMatchObject({ status: 401 });
    await expect(remoteRequest(fixture, "POST", "/api/v1/access-links", undefined, cookie, asRemote)).resolves.toMatchObject({ status: 401 });
    await expect(remoteRequest(fixture, "DELETE", "/api/v1/access-links/whatever", undefined, cookie, asRemote)).resolves.toMatchObject({ status: 401 });
    await expect(remoteRequest(fixture, "POST", "/api/v1/remote-identity/rotations", undefined, cookie, asRemote)).resolves.toMatchObject({ status: 401 });

    // 그 손님이 자기 handle을 알아도 끊는 일은 이 기계 앞에서만 일어난다.
    const paired = (await readRemoteStatus(fixture)).devices[0]!;
    await expect(remoteRequest(fixture, "DELETE", `/api/v1/access-sessions/${paired.sessionHandle}`, undefined, cookie, asRemote)).resolves.toMatchObject({ status: 401 });
    await expect(remoteRequest(fixture, "DELETE", `/api/v1/paired-devices/${paired.id}`, undefined, cookie, asRemote)).resolves.toMatchObject({ status: 401 });
    expect((await readRemoteStatus(fixture)).devices).toHaveLength(1);
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

  /**
   * 자리를 비우는 순서가 이 규칙의 절반이다. 조인이 앞사람을 대신하게 되면서, 거절 판정이
   * 축출보다 먼저 끝나야 한다는 조건이 생겼다 — 그러지 않으면 받아 주지도 않을 조인이
   * 붙어 있던 기기를 끊어 놓고, 자리는 아무도 쓰지 않은 채 빈다.
   *
   * 기억 상한이 그 순서를 시험할 수 있는 유일한 거절이므로, 상한을 실제로 채워서 본다.
   */
  it("leaves the open session untouched when the join is refused at the pairing limit", async () => {
    const fixture = await startFixture({ remote: true });
    const local = await openLoopbackEvents(fixture);

    let holder = "";
    for (let index = 0; index < PAIRED_DEVICE_LIMIT; index += 1) {
      holder = await joinAs(fixture, "full", `device-${index}`);
    }
    const seated = await local.waitFor("control:changed", (data) => data.holder?.device === `device-${PAIRED_DEVICE_LIMIT - 1}`);
    const framesBefore = local.seen("control:changed");

    const spare = await createLink(fixture);
    const refused = await remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token: grantTokenOf(spare), device: "one too many" }));
    expect(refused.status).toBe(409);
    expect(refused.body).toContain("paired_device_limit");

    // 앉아 있던 기기는 그대로다 — 세션도, 이 기계가 보는 보유자도 움직이지 않는다.
    await expect(remoteRequest(fixture, "GET", "/api/v1/theaters", undefined, holder)).resolves.toMatchObject({ status: 200 });
    expect(local.seen("control:changed")).toBe(framesBefore);
    expect((await readRemoteStatus(fixture)).devices.filter((entry) => entry.sessionHandle !== null)).toHaveLength(1);

    // 자격도 타지 않았다. 자리를 비우면 같은 링크가 아직 통해야 한다.
    await expect(revoke(fixture, `access-sessions/${seated.holder.handle}`)).resolves.toBe(204);
    await expect(revoke(fixture, `paired-devices/${(await readRemoteStatus(fixture)).devices[0]!.id}`)).resolves.toBe(204);
    await expect(remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token: grantTokenOf(spare) }))).resolves.toMatchObject({ status: 204 });

    local.close();
  });

  /**
   * 같은 기기가 자기 접속을 갈아 끼울 때 건너뛰는 것은 안내뿐이다. 두고 간 스트림까지 함께
   * 남겨 두면 자격이 죽은 그 구독이 다음 Operation 갱신부터 계속 받는다 — 앞의 화면을 아직
   * 띄운 채 다시 조인하는 흐름이 실제로 있으므로, 상대가 스스로 물러나 주기를 기대할 수 없다.
   */
  it("closes the stream a device leaves behind when it rejoins under its own pairing", async () => {
    const fixture = await startFixture({ remote: true });
    const cookies = await joinAs(fixture, "full", "MacBook Pro");
    const stale = await openRemoteEvents(fixture, cookies);

    await expect(remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({}), cookies)).resolves.toMatchObject({ status: 204 });

    await stale.waitForClose();
    // 자기 자신에게 "다른 기기가 이어받았습니다"를 띄우지는 않는다.
    expect(stale.seen("control:reclaimed")).toBe(0);

    stale.close();
  });

  /**
   * 밀려난 쪽은 자기가 왜 끊겼는지 듣는다. 주인이 되찾은 것과 다른 기기가 이어받은 것을 한
   * 사유로 뭉개면, 아무도 회수하지 않았는데 "회수되었습니다"가 뜬다.
   */
  it("tells only the displaced session that another device took the seat", async () => {
    const fixture = await startFixture({ remote: true });
    const local = await openLoopbackEvents(fixture);

    const cookie = await joinAs(fixture, "full", "Kitchen iPad");
    const displaced = await openRemoteEvents(fixture, cookie);
    await local.waitFor("control:changed", (data) => data.holder?.device === "Kitchen iPad");

    await joinAs(fixture, "full", "MacBook Pro");

    expect(await displaced.waitFor("control:reclaimed", () => true)).toEqual({ reason: "superseded" });
    /**
     * 안내만 보내고 스트림을 남겨 두면, 자격을 잃은 그 기기가 다음 Operation 갱신부터 계속
     * 받는다 — 이 스트림에는 요청마다 걸리는 세션 게이트가 없다. 서버가 닫아야 한다.
     */
    await displaced.waitForClose();
    // 이 기계 앞 화면은 보유자가 바뀐 것을 듣는다 — 커튼은 새 기기의 이름을 단다.
    expect((await local.waitFor("control:changed", (data) => data.holder?.device === "MacBook Pro")).holder)
      .toMatchObject({ device: "MacBook Pro" });
    // 밀려난 원격은 다른 기기의 이름을 한 번도 받지 않는다.
    expect(displaced.seen("control:changed")).toBe(0);

    local.close();
    displaced.close();
  });

  /**
   * 커튼이 뜨고 걷히는 근거 전체. 보유자 정보는 이 기계 앞 화면에만 가고, 회수 통지는 끊긴
   * 세션 하나에만 간다 — 두 수신자가 갈리지 않으면 원격 화면에 다른 기기의 이름이 실린다.
   */
  it("tells the local console who holds control, and tells only the evicted session it was reclaimed", async () => {
    const fixture = await startFixture({ remote: true });
    const local = await openLoopbackEvents(fixture);

    const cookie = await joinAs(fixture, "full", "Kitchen iPad");
    const remote = await openRemoteEvents(fixture, cookie);

    const held = await local.waitFor("control:changed", (data) => data.holder !== null);
    expect(held.holder).toMatchObject({ device: "Kitchen iPad" });
    expect(typeof held.holder.handle).toBe("string");

    await expect(revoke(fixture, `access-sessions/${held.holder.handle}`)).resolves.toBe(204);

    // 끊긴 쪽은 자기 회수를 듣고, 그 구독은 서버가 닫는다.
    expect(await remote.waitFor("control:reclaimed", () => true)).toEqual({ reason: "reclaimed" });
    await remote.waitForClose();
    // 이 기계 앞 화면은 보유자가 사라진 것을 듣는다.
    expect(await local.waitFor("control:changed", (data) => data.holder === null)).toEqual({ holder: null });
    // 원격은 보유자 정보를 한 번도 받지 않는다.
    expect(remote.seen("control:changed")).toBe(0);

    local.close();
    remote.close();
  });

  /**
   * 만료는 조용하다. 알리지 않으면 화면은 이미 없는 보유자를 계속 띄우고, 그 보유자를 향한
   * 회수는 404로 끝나 화면이 스스로 정리되지도 못한다.
   */
  it("clears a stale holder when the reclaim finds the session already gone", async () => {
    const fixture = await startFixture({ remote: true });
    const local = await openLoopbackEvents(fixture);
    await joinAs(fixture, "full", "Ghost");
    const held = await local.waitFor("control:changed", (data) => data.holder !== null);

    await expect(revoke(fixture, `access-sessions/${held.holder.handle}`)).resolves.toBe(204);
    await local.waitFor("control:changed", (data) => data.holder === null);

    // 이미 사라진 세션을 다시 회수해도 화면이 정리되는 신호는 한 번 더 나간다.
    const seenBefore = local.seen("control:changed");
    await expect(revoke(fixture, `access-sessions/${held.holder.handle}`)).resolves.toBe(404);
    await vi.waitFor(() => expect(local.seen("control:changed")).toBeGreaterThan(seenBefore));
    expect(await local.waitFor("control:changed", (data) => data.holder === null)).toEqual({ holder: null });

    local.close();
  });

  /**
   * monitoring은 제어를 쥔 적이 없으므로 그 세션이 오가도 보유자는 내내 없다. 그때까지 신호로
   * 세면 붙어 있던 터미널이 통째로 끊겼다 다시 붙으며 scrollback을 재생한다 — 아무것도 바뀌지
   * 않았는데 화면이 깜빡인다.
   */
  it("stays quiet when a session that never held control comes and goes", async () => {
    const fixture = await startFixture({ remote: true });
    const local = await openLoopbackEvents(fixture);
    await local.waitFor("control:changed", (data) => data.holder === null);

    const framesBefore = local.seen("control:changed");
    await joinAs(fixture, "monitoring", "watcher");
    const watcher = (await readRemoteStatus(fixture)).devices.find((entry) => entry.access === "monitoring");
    await expect(revoke(fixture, `access-sessions/${watcher!.sessionHandle}`)).resolves.toBe(204);

    // 보유자는 내내 없었다. 프레임이 늘지 않아야 한다.
    expect(local.seen("control:changed")).toBe(framesBefore);

    // full이 오가면 그때는 알린다 — 조용해진 것이지 멎은 것이 아니다.
    await joinAs(fixture, "full", "holder");
    const held = await local.waitFor("control:changed", (data) => data.holder !== null);
    await expect(revoke(fixture, `access-sessions/${held.holder.handle}`)).resolves.toBe(204);
    expect(await local.waitFor("control:changed", (data) => data.holder === null)).toEqual({ holder: null });

    local.close();
  });

  /** 자리는 등급을 가리지 않는다 — monitoring 조인도 앞의 full을 대신하고, 커튼은 그때 걷힌다. */
  it("lets a monitoring join take the seat from a full session", async () => {
    const fixture = await startFixture({ remote: true });
    const local = await openLoopbackEvents(fixture);
    await joinAs(fixture, "full", "holder");
    await local.waitFor("control:changed", (data) => data.holder !== null);

    await joinAs(fixture, "monitoring", "watcher");

    const status = await readRemoteStatus(fixture);
    expect(status.devices.filter((entry) => entry.sessionHandle !== null).map((entry) => entry.access)).toEqual(["monitoring"]);
    expect(await local.waitFor("control:changed", (data) => data.holder === null)).toEqual({ holder: null });

    local.close();
  });

  /**
   * 이 파일에서 가장 중요한 줄. 제어권을 회수당한 기기는 스스로 돌아올 수 있어야 한다 —
   * 자격이 곧 세션이던 시절에는 회수가 자격까지 지워, 그 기기는 새 링크를 받기 전에는
   * 영영 돌아오지 못했다. 링크는 이미 소진되었고 저장된 호스트에는 자격이 없기 때문이다.
   */
  it("lets a device return under its pairing after the local console takes control away", async () => {
    const fixture = await startFixture({ remote: true });
    const cookies = await joinAs(fixture, "full", "MacBook Pro");
    const handle = (await readRemoteStatus(fixture)).devices[0]!.sessionHandle!;

    await expect(revoke(fixture, `access-sessions/${handle}`)).resolves.toBe(204);
    await expect(remoteRequest(fixture, "GET", "/api/v1/theaters", undefined, cookies)).resolves.toMatchObject({ status: 401 });

    // 링크 없이, 들고 있던 페어링 쿠키만으로 다시 붙는다.
    const resumed = await remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({}), cookies);
    expect(resumed.status).toBe(204);

    // 그리고 다시 제어를 쥔다 — 자리가 비어 있었으므로 등급이 깎이지 않는다.
    const back = await readRemoteStatus(fixture);
    expect(back.devices).toHaveLength(1);
    expect(back.devices[0]).toMatchObject({ device: "MacBook Pro", access: "full" });
    expect(back.devices[0]!.sessionHandle).not.toBeNull();
    expect(back.devices[0]!.sessionHandle).not.toBe(handle);
    await expect(remoteRequest(fixture, "GET", "/api/v1/theaters", undefined, cookiesOf(resumed))).resolves.toMatchObject({ status: 200 });
  });

  /** 재개는 링크와 달리 소모되지 않는다 — 콘솔이 살아 있는 한 몇 번이든 돌아온다. */
  it("resumes the same pairing more than once", async () => {
    const fixture = await startFixture({ remote: true });
    const cookies = await joinAs(fixture, "full", "MacBook Pro");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const handle = (await readRemoteStatus(fixture)).devices[0]!.sessionHandle!;
      await expect(revoke(fixture, `access-sessions/${handle}`)).resolves.toBe(204);
      await expect(remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({}), cookies)).resolves.toMatchObject({ status: 204 });
    }

    expect((await readRemoteStatus(fixture)).devices).toHaveLength(1);
  });

  /**
   * 접속을 끊는 것과 손님을 내보내는 것은 다른 결정이다. 이쪽은 되돌아올 길까지 없앤다.
   */
  it("shuts a removed device out and clears the cookie it kept sending", async () => {
    const fixture = await startFixture({ remote: true });
    const cookies = await joinAs(fixture, "full", "MacBook Pro");
    const paired = (await readRemoteStatus(fixture)).devices[0]!;

    await expect(revoke(fixture, `paired-devices/${paired.id}`)).resolves.toBe(204);
    await expect(revoke(fixture, `paired-devices/${paired.id}`)).resolves.toBe(404);

    // 자격을 거두면서 그 자격으로 열려 있던 접속도 함께 끊긴다.
    expect((await readRemoteStatus(fixture)).devices).toHaveLength(0);
    await expect(remoteRequest(fixture, "GET", "/api/v1/theaters", undefined, cookies)).resolves.toMatchObject({ status: 401 });

    const refused = await remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({}), cookies);
    expect(refused.status).toBe(401);
    // 죽은 값을 계속 보내지 않도록 그 기기에서도 지운다.
    expect((refused.headers["set-cookie"] ?? []).join("; ")).toContain("Max-Age=0");
  });

  /**
   * 원격을 껐다 켜는 것은 자격을 거두는 결정이 아니다. 리스너가 닫히면 접속은 사라지지만,
   * 같은 인증서로 다시 열린 콘솔은 그 기기를 여전히 알아본다.
   */
  it("keeps pairings across a remote listener restart", async () => {
    const fixture = await startFixture({ remote: true });
    const cookies = await joinAs(fixture, "full", "MacBook Pro");

    await saveRemoteAccess(fixture, { enabled: false, bindHost: BIND_HOST });
    await saveRemoteAccess(fixture, { enabled: true, bindHost: BIND_HOST });

    const reopened = await readRemoteStatus(fixture);
    expect(reopened.devices).toHaveLength(1);
    expect(reopened.devices[0]!.sessionHandle).toBeNull();
    await expect(remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({}), cookies)).resolves.toMatchObject({ status: 204 });
  });

  /**
   * 위 테스트가 볼 수 없던 절반. 살아 있는 서버의 설정을 껐다 켜면 포트가 그대로라, 이름에
   * 포트가 박힌 쿠키도 저장된 주소도 어긋날 일이 없다. 진짜 재기동은 콘솔 포트를 다시 뽑는다 —
   * 원격이 그 포트를 따라가던 동안에는 페어링이 남아 있어도 그 기기는 죽은 주소를 두드렸다.
   */
  it("reopens the published port after a console restart moves the console port", async () => {
    const first = await startFixture({ remote: true });
    const cookies = await joinAs(first, "full", "MacBook Pro");
    const publishedOrigin = (await readRemoteStatus(first)).listener.origin;
    const consolePort = Number(new URL(first.loopbackEndpoint).port);

    const restarted = await restartFixture(first);

    // 콘솔 포트는 새로 뽑혔지만, 손님에게 알려 준 주소는 그대로여야 한다.
    expect(Number(new URL(restarted.loopbackEndpoint).port)).not.toBe(consolePort);
    const status = await readRemoteStatus(restarted);
    expect(status.listener.origin).toBe(publishedOrigin);
    expect(status.devices).toHaveLength(1);
    expect(status.devices[0]!.sessionHandle).toBeNull();

    // 그리고 링크 없이, 처음 받은 그 쿠키만으로 돌아온다.
    await expect(remoteRequest(restarted, "POST", "/api/v1/join", JSON.stringify({}), cookies)).resolves.toMatchObject({ status: 204 });
  });

  /** 페어링이 없어도 주소는 약속이다 — 링크를 받아 갈 기기가 아직 없을 때도 같은 곳이 열린다. */
  it("keeps the published port even when the console port moves before anyone pairs", async () => {
    const first = await startFixture({ remote: true });
    const publishedOrigin = (await readRemoteStatus(first)).listener.origin;

    const restarted = await restartFixture(first);

    await expect(readRemoteStatus(restarted).then((status) => status.listener.origin)).resolves.toBe(publishedOrigin);
  });

  /**
   * 안내가 가리키는 복구 경로를 실제로 밟아 본다. 공표한 포트를 남이 쥐면 원격은 열리지 않고
   * 지문도 없는데, 그때 갱신이 막히면 안내가 지키지 못할 약속이 된다 — 리스너가 없는 상태가
   * 바로 이 버튼이 필요한 자리다.
   */
  /**
   * 공개 엔드포인트에 443은 가장 자연스러운 선택인데, 스킴의 기본 포트를 권위에 적어 두면
   * 기기가 보내는 `Host: host`와 어긋나 정상 접속이 전부 막힌다. 쿠키 이름이 쓰는 숫자 포트는
   * 그대로여야 하므로 정규화는 문자열 권위에만 적용된다.
   */
  it("accepts the authority a client sends when the advertised port is the scheme default", async () => {
    const listenPort = await reservePort(BIND_HOST);
    const remoteAccess: ConsoleRemoteAccessSettings = {
      enabled: true,
      publicEndpointEnabled: true,
      listenAddress: BIND_HOST,
      advertisedHost: "nat.example.test",
      listenPort: { mode: "custom", value: listenPort },
      advertisedPort: { mode: "custom", value: 443 },
      acknowledgment: { version: 1, listenAddress: BIND_HOST, listenPort, advertisedHost: "nat.example.test", advertisedPort: 443 },
    };
    const fixture = await startFixture({ remote: true, remoteAccess });

    expect((await readRemoteStatus(fixture)).listener.origin).toBe("https://nat.example.test");

    /**
     * 실제 클라이언트는 https://nat.example.test 로 붙으므로 기본 포트를 생략한 Host를 보낸다.
     * 테스트는 NAT가 없으니 수신 소켓에 직접 붙되 그 헤더를 그대로 흉내 낸다. Host 게이트를
     * 지나면 자격이 없어 401이고, 403 host_mismatch면 문 앞에서 막힌 것이다.
     */
    const send = (hostHeader: string) => new Promise<{ status: number; cookies: readonly string[] }>((resolve, reject) => {
      const body = JSON.stringify({ token: "probe" });
      const request = https.request({
        host: BIND_HOST, port: listenPort, path: "/api/v1/join", method: "POST",
        rejectUnauthorized: false, checkServerIdentity: () => undefined,
        headers: { host: hostHeader, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      }, (response) => {
        response.resume();
        response.on("end", () => resolve({ status: response.statusCode ?? 0, cookies: response.headers["set-cookie"] ?? [] }));
      });
      request.on("error", reject);
      request.write(body);
      request.end();
    });

    await expect(send("nat.example.test")).resolves.toMatchObject({ status: 401 });
    // 정규화하지 않은 형태도 계속 받는다 — 기존 기기가 그렇게 보내고 있을 수 있다.
    await expect(send("nat.example.test:443")).resolves.toMatchObject({ status: 401 });
  });

  /**
   * 인증서가 바뀌면 페어링은 사라져야 한다. `ensure()`는 회전한 인증서를 bind보다 먼저 디스크에
   * 남기므로, bind 실패로 취소를 건너뛰면 다음 기동에서는 그 새 인증서가 previousIdentity가 되어
   * 변화가 감지되지 않는다 — 사라진 인증서에 묶인 페어링이 목록에만 살아남는다.
   */
  it("voids pairings for a renewed certificate even when the listener then fails to bind", async () => {
    const paired = await startFixture({ remote: true });
    await joinAs(paired, "full", "MacBook Pro");
    const published = Number(new URL((await readRemoteStatus(paired)).listener.origin!).port);
    expect((await readRemoteStatus(paired)).devices).toHaveLength(1);

    // 주인이 공표 이름을 바꾼다 — 신원이 회전할 조건. 그리고 그 포트를 남이 쥔 채로 다시 뜬다.
    await stopFixture(paired);
    const settingsPath = path.join(paired.dir, "fleet-home", "console", "settings.json");
    const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { general: { remoteAccess: ConsoleRemoteAccessSettings } };
    const renamed = { ...saved.general.remoteAccess, advertisedHost: "renamed.example.test" };
    fs.writeFileSync(settingsPath, JSON.stringify({
      ...saved,
      general: {
        ...saved.general,
        remoteAccess: { ...renamed, acknowledgment: { version: 1 as const, listenAddress: renamed.listenAddress, listenPort: renamed.listenPort.value, advertisedHost: renamed.advertisedHost, advertisedPort: renamed.advertisedPort.value } },
      },
    }));
    const squatter = http.createServer();
    await new Promise<void>((resolve, reject) => {
      squatter.once("error", reject);
      squatter.listen(published, BIND_HOST, () => { squatter.off("error", reject); resolve(); });
    });
    try {
      const stuck = await bootFixtureFrom(paired);
      const failed = await readRemoteStatus(stuck);

      expect(failed.listener.listening).toBe(false);
      // 인증서는 이미 갈렸다. 그 기기가 신뢰하던 지문은 사라졌으므로 목록에 남기면 거짓말이 된다.
      expect(failed.devices).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  it("keeps an occupied Custom port after destructive identity rotation without falling back", async () => {
    const paired = await startFixture({ remote: true });
    await joinAs(paired, "full", "MacBook Pro");
    const published = Number(new URL((await readRemoteStatus(paired)).listener.origin!).port);

    // 콘솔을 내려 두고 그 포트를 남이 잡는다. 그 상태로 다시 뜨는 것이 사용자가 겪는 순서다.
    await stopFixture(paired);
    const squatter = http.createServer();
    await new Promise<void>((resolve, reject) => {
      squatter.once("error", reject);
      squatter.listen(published, BIND_HOST, () => { squatter.off("error", reject); resolve(); });
    });
    try {
      const stuck = await bootFixtureFrom(paired);
      const failed = await readRemoteStatus(stuck);
      expect(failed.listener.listening).toBe(false);
      expect(failed.listener.lastError).toBe("custom_port_unavailable");

      const rotated = await fetch(`${stuck.loopbackEndpoint}api/v1/remote-identity/rotations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${stuck.lockToken}` },
      });
      expect(rotated.status).toBe(500);

      const afterRotation = await readRemoteStatus(stuck);
      expect(afterRotation.listener.listening).toBe(false);
      expect(afterRotation.listener.lastError).toBe("custom_port_unavailable");
      expect(afterRotation.devices).toHaveLength(0);
      const saved = JSON.parse(fs.readFileSync(path.join(stuck.dir, "fleet-home", "console", "settings.json"), "utf8")) as { general: { remoteAccess: { listenPort: { value: number }; advertisedPort: { value: number } } } };
      expect(saved.general.remoteAccess.listenPort.value).toBe(published);
      expect(saved.general.remoteAccess.advertisedPort.value).toBe(published);
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  /**
   * 신원 갱신은 이미 손님을 전부 내보내는 자리다. 그 순간에는 주소를 붙들 이유가 없고, 남이
   * 그 포트를 쥐어 원격이 열리지 않을 때 빠져나오는 길도 이것 하나뿐이다.
   */
  it("preserves configured Custom ports when the identity is rotated", async () => {
    const restarted = await restartFixture(await startFixture({ remote: true }));
    const before = (await readRemoteStatus(restarted)).listener.origin;

    const rotated = await fetch(`${restarted.loopbackEndpoint}api/v1/remote-identity/rotations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${restarted.lockToken}` },
    });
    expect(rotated.status).toBe(200);

    await expect(readRemoteStatus(restarted).then((status) => status.listener.origin)).resolves.toBe(before);
  });

  /**
   * 재개는 자리를 되찾을 뿐 등급을 올리지 못한다. 페어링이 등급의 유일한 근거이므로, 자리를
   * 이어받았다고 해서 관전자가 명령을 실행하게 되어서는 안 된다.
   */
  it("resumes a monitoring pairing as monitoring even when it takes the seat from a full device", async () => {
    const fixture = await startFixture({ remote: true });
    const watcher = await joinAs(fixture, "monitoring", "iPad");
    await joinAs(fixture, "full", "MacBook Pro");

    const resumed = await remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({}), watcher);
    expect(resumed.status).toBe(204);
    await expect(readRemoteStatus(fixture).then((status) => status.devices.filter((entry) => entry.sessionHandle !== null).map((entry) => entry.device)))
      .resolves.toEqual(["iPad"]);

    const cookies = cookiesOf(resumed);
    await expect(remoteRequest(fixture, "GET", "/api/v1/theaters", undefined, cookies)).resolves.toMatchObject({ status: 200 });
    await expect(remoteRequest(fixture, "POST", "/api/v1/theaters", "{}", cookies)).resolves.toMatchObject({ status: 401 });
  });

  /**
   * 자리가 차 있어도 페어링된 기기는 돌아온다. 거절하던 시절에는 앞 기기가 두고 간 접속 하나가
   * 주인이 자기 콘솔 앞에 가서 그 줄을 끊기 전까지 나머지 기기를 전부 밖에 세워 두었다.
   */
  it("lets a full pairing resume by taking the seat from the device that holds it", async () => {
    const fixture = await startFixture({ remote: true });
    const first = await joinAs(fixture, "full", "first");
    const held = (await readRemoteStatus(fixture)).devices[0]!.sessionHandle!;
    await expect(revoke(fixture, `access-sessions/${held}`)).resolves.toBe(204);
    const second = await joinAs(fixture, "full", "second");

    await expect(remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({}), first)).resolves.toMatchObject({ status: 204 });

    await expect(readRemoteStatus(fixture).then((status) => status.devices.filter((entry) => entry.sessionHandle !== null).map((entry) => entry.device)))
      .resolves.toEqual(["first"]);
    await expect(remoteRequest(fixture, "GET", "/api/v1/theaters", undefined, second)).resolves.toMatchObject({ status: 401 });
  });

  /**
   * 인증서는 명시적 갱신 말고도 바뀐다. 바인드 주소를 옮기면 `ensure`가 조용히 새로 만드는데,
   * 그 순간 옛 지문을 믿던 페어링은 이 콘솔에 닿을 수 없다 — 목록과 상한만 차지한다.
   */
  it("unpairs every device when the listener silently takes a new certificate", async () => {
    const fixture = await startFixture({ remote: true });
    await joinAs(fixture, "full", "MacBook Pro");
    const before = await readRemoteStatus(fixture);
    expect(before.devices).toHaveLength(1);

    /**
     * 바인드 주소를 옮긴 상태를 만든다. 저장된 신원이 다른 host의 것이 되면 `ensure`는 명시적
     * 갱신 없이도 새 인증서를 만든다 — 바로 위 "재시작해도 페어링은 남는다"와 같은 재시작
     * 경로이면서 지문만 달라지는 대비다.
     */
    const metaFile = path.join(fixture.dir, "fleet-home", "console", "remote", "identity.json");
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(metaFile, JSON.stringify({ ...meta, host: "moved.example" }));
    await saveRemoteAccess(fixture, { enabled: false, bindHost: BIND_HOST });
    await saveRemoteAccess(fixture, { enabled: true, bindHost: BIND_HOST });

    const after = await readRemoteStatus(fixture);
    expect(normalizeFingerprint(after.fingerprint!)).not.toBe(normalizeFingerprint(before.fingerprint!));
    expect(after.devices).toHaveLength(0);
  });

  /**
   * 그리고 그 순간에는 공표한 포트도 놓는다. 아무도 이 주소로 돌아오지 못하므로 붙들 이유가
   * 없고, 그사이 남이 그 포트를 쥐었다면 놓지 않는 편이 원격을 아예 못 열게 만든다.
   */
  it("preserves configured Custom ports when the certificate silently changes", async () => {
    const restarted = await restartFixture(await startFixture({ remote: true }));
    const before = (await readRemoteStatus(restarted)).listener.origin;

    const metaFile = path.join(restarted.dir, "fleet-home", "console", "remote", "identity.json");
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(metaFile, JSON.stringify({ ...meta, host: "moved.example" }));
    await saveRemoteAccess(restarted, { enabled: false, bindHost: BIND_HOST });
    await saveRemoteAccess(restarted, { enabled: true, bindHost: BIND_HOST });

    await expect(readRemoteStatus(restarted).then((status) => status.listener.origin)).resolves.toBe(before);
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
