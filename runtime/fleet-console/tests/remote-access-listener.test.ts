import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
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
    expect(after.listening).toBe(true);
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
   * 제어를 쥔 원격은 하나다. 둘째를 받으면 커튼이 "누가" 몰고 있는지 하나로 말하지 못하고
   * 회수 버튼의 대상도 갈라진다. 거절은 자격을 태우기 전에 일어나야 한다 — 뒤에서 막으면
   * 1회용 링크만 소멸하고 아무도 붙지 못한다.
   */
  it("admits one full remote session and leaves the refused link usable", async () => {
    const fixture = await startFixture({ remote: true });
    await joinAs(fixture, "full", "first");
    const secondLink = await createLink(fixture);

    const refused = await remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token: grantTokenOf(secondLink) }));
    expect(refused.status).toBe(409);

    const held = await readRemoteStatus(fixture);
    expect(held.devices).toHaveLength(1);
    expect(held.links).toHaveLength(1);

    // 보유자가 물러나면 같은 링크가 그대로 통한다 — 태워 버렸다면 여기서 401이 난다.
    await expect(revoke(fixture, `access-sessions/${held.devices[0]!.sessionHandle}`)).resolves.toBe(204);
    await expect(remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token: grantTokenOf(secondLink) }))).resolves.toMatchObject({ status: 204 });
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

    // 끊긴 쪽은 자기 회수를 듣는다.
    expect(await remote.waitFor("control:reclaimed", () => true)).toEqual({ reason: "reclaimed" });
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
   * monitoring은 제어를 쥔 적이 없으므로 그 세션이 사라져도 보유자는 그대로다. 그때까지 신호로
   * 세면 붙어 있던 터미널이 통째로 끊겼다 다시 붙으며 scrollback을 재생한다 — 아무것도 바뀌지
   * 않았는데 화면이 깜빡인다.
   */
  it("stays quiet when a session that never held control goes away", async () => {
    const fixture = await startFixture({ remote: true });
    const local = await openLoopbackEvents(fixture);
    await joinAs(fixture, "full", "holder");
    const held = await local.waitFor("control:changed", (data) => data.holder !== null);
    await joinAs(fixture, "monitoring", "watcher");

    const watcher = (await readRemoteStatus(fixture)).devices.find((entry) => entry.access === "monitoring");
    const framesBefore = local.seen("control:changed");
    await expect(revoke(fixture, `access-sessions/${watcher!.sessionHandle}`)).resolves.toBe(204);

    // 보유자는 그대로다. 프레임이 늘지 않아야 한다.
    await expect(readRemoteStatus(fixture).then((status) => status.devices.filter((entry) => entry.sessionHandle !== null))).resolves.toHaveLength(1);
    expect(local.seen("control:changed")).toBe(framesBefore);

    // 진짜 보유자가 나가면 그때는 알린다 — 조용해진 것이지 멎은 것이 아니다.
    await expect(revoke(fixture, `access-sessions/${held.holder.handle}`)).resolves.toBe(204);
    expect(await local.waitFor("control:changed", (data) => data.holder === null)).toEqual({ holder: null });

    local.close();
  });

  /** monitoring은 제어를 쥐지 않으므로 상한과 무관하게 full 옆에 함께 붙는다. */
  it("lets a monitoring session join while a full session holds control", async () => {
    const fixture = await startFixture({ remote: true });
    await joinAs(fixture, "full", "holder");
    await joinAs(fixture, "monitoring", "watcher");

    const status = await readRemoteStatus(fixture);
    expect(status.devices.map((entry) => entry.access).sort()).toEqual(["full", "monitoring"]);
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

  /** 재개는 등급을 물려받을 뿐 올리지 못한다. 페어링이 등급의 유일한 근거다. */
  it("resumes a monitoring pairing as monitoring, and refuses control while a full device holds it", async () => {
    const fixture = await startFixture({ remote: true });
    const watcher = await joinAs(fixture, "monitoring", "iPad");
    await joinAs(fixture, "full", "MacBook Pro");

    const resumed = await remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({}), watcher);
    expect(resumed.status).toBe(204);

    const cookies = cookiesOf(resumed);
    await expect(remoteRequest(fixture, "GET", "/api/v1/theaters", undefined, cookies)).resolves.toMatchObject({ status: 200 });
    await expect(remoteRequest(fixture, "POST", "/api/v1/theaters", "{}", cookies)).resolves.toMatchObject({ status: 401 });
  });

  /** 두 번째 full 기기는 자리가 차 있는 동안 돌아오지 못한다 — 축출은 주인의 결정이다. */
  it("refuses a full pairing that tries to resume while another device holds control", async () => {
    const fixture = await startFixture({ remote: true });
    const first = await joinAs(fixture, "full", "first");
    const held = (await readRemoteStatus(fixture)).devices[0]!.sessionHandle!;
    await expect(revoke(fixture, `access-sessions/${held}`)).resolves.toBe(204);
    await joinAs(fixture, "full", "second");

    await expect(remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({}), first)).resolves.toMatchObject({ status: 409 });
  });

  /** 저장된 것은 해시뿐이다 — 이 파일이 새어도 그것으로 붙을 수 없다. */
  it("writes no pairing secret to disk", async () => {
    const fixture = await startFixture({ remote: true });
    const cookies = await joinAs(fixture, "full", "MacBook Pro");
    const secret = /fleet_console_pairing_\d+=([^;]+)/u.exec(cookies)?.[1];
    expect(secret).toBeTruthy();

    const stored = fs.readFileSync(path.join(fixture.dir, "fleet-home", "console", "paired-devices.json"), "utf8");

    expect(stored).not.toContain(secret!);
    expect(JSON.parse(stored)).toMatchObject({ version: 1, devices: [{ device: "MacBook Pro", access: "full" }] });
  });
});

interface RemoteAccessStatus {
  readonly listening: boolean;
  readonly origin: string | null;
  readonly fingerprint: string | null;
  readonly lastError: string | null;
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
  close(): void;
}

function readEventStream(response: import("node:http").IncomingMessage): EventProbe {
  const received: Array<{ readonly event: string; readonly data: unknown }> = [];
  const waiters: Array<() => void> = [];
  let buffer = "";
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
