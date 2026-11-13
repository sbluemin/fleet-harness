import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import type { Readable } from "node:stream";
import tls from "node:tls";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readConsoleLockFile } from "@fleet-console/lifecycle";
import { PAIRED_DEVICE_LIMIT } from "../features/remote-access/host/paired-devices.js";
import * as remoteAuth from "../features/remote-access/host/auth.js";
import { CONSOLE_ROSTER_PATH, isConsoleRosterSummary } from "../protocol/desktop/console-section.js";
import { consoleRosterCommanders, consoleRosterLook, consoleRosterPreview, consoleRosterRun, consoleRosterSections, rosterCommanderIncluded, ROSTER_SORT_DEFAULT, type RosterCommanderSource } from "../features/commodore/host/roster.js";
import { normalizeFingerprint } from "../features/remote-access/host/remote-identity.js";
import { parseAccessLink } from "../features/remote-access/host/access-link.js";
import { createConsoleServer, type ConsoleServer, type ConsoleServerDeps } from "../core/host/bootstrap/server.js";
import type { ConsoleRemoteAccessSettings } from "../features/settings/host/settings-domain.js";

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
  vi.restoreAllMocks();
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

    await expect(remoteRequest(fixture, "GET", "/api/v1/objectives/records")).resolves.toMatchObject({ status: 401 });
    await expect(remoteRequest(fixture, "GET", "/console/")).resolves.toMatchObject({ status: 401 });
    await expect(remoteRequest(fixture, "GET", "/api/v1/status")).resolves.toMatchObject({ status: 401 });
  });

  it("reads only the minimized roster with a live pairing without opening or changing a session", async () => {
    // 실제 레지스트리를 관찰한다 — 인증·세션 판정은 대역으로 바꾸지 않는다.
    const registryFactory = vi.spyOn(remoteAuth, "createAccessRegistry");
    const fixture = await startFixture({ remote: true });
    const access = registryFactory.mock.results[0]!.value as remoteAuth.AccessRegistry;
    const origin = fixture.loopbackEndpoint.replace(/\/$/u, "");
    const created = await fetch(`${origin}/api/v1/commodore/create`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ alias: "명부 사령관" }) });
    expect(created.status).toBe(200);
    const { commodoreId } = await created.json() as { commodoreId: string };
    const painted = await fetch(`${origin}/api/v1/avatars`, { method: "PUT", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ mode: "set", key: `theater:commodore:${commodoreId}`, base: 2, tone: "teal" }) });
    expect(painted.status).toBe(200);
    const expected = { v: 1, commodores: [{ id: commodoreId, name: "명부 사령관", look: { base: 2, tone: "teal" }, run: "quiet" }], more: 0 };
    for (const headers of [{} as Record<string, string>, { Origin: origin }]) {
      const response = await fetch(`${origin}${CONSOLE_ROSTER_PATH}`, { headers });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expected);
    }
    expect((await fetch(`${origin}${CONSOLE_ROSTER_PATH}`, { headers: { Origin: "http://other.invalid" } })).status).toBe(401);
    expect((await fetch(`${origin}${CONSOLE_ROSTER_PATH}`, { method: "POST" })).status).toBe(405);
    expect((await remoteRequest(fixture, "GET", CONSOLE_ROSTER_PATH)).status).toBe(401);

    const snapshot = () => ({ full: access.hasSession("remote", "full"), monitoring: access.hasSession("remote", "monitoring"), sessions: access.listSessions("remote") });
    const readWithoutChange = async (cookie: string) => {
      const before = snapshot();
      const devices = (await readRemoteStatus(fixture)).devices;
      const response = await remoteRequest(fixture, "GET", CONSOLE_ROSTER_PATH, undefined, cookie);
      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(Buffer.byteLength(response.body, "utf8")).toBeLessThanOrEqual(16_384);
      expect(isConsoleRosterSummary(JSON.parse(response.body))).toBe(true);
      expect(JSON.parse(response.body)).toEqual(expected);
      expect(snapshot()).toEqual(before);
      expect((await readRemoteStatus(fixture)).devices).toEqual(devices);
    };
    const full = await joinAs(fixture, "full", "roster-device");
    expect(snapshot()).toMatchObject({ full: true, monitoring: false });
    await readWithoutChange(full);
    expect((await remoteRequest(fixture, "POST", CONSOLE_ROSTER_PATH, "{}", full)).status).toBe(401);
    const fullSession = full.split("; ").find((cookie) => cookie.startsWith("fleet_console_session_"))!;
    expect((await remoteRequest(fixture, "GET", CONSOLE_ROSTER_PATH, undefined, fullSession)).status).toBe(200);
    const paired = full.split("; ").find((cookie) => cookie.startsWith("fleet_console_pairing_"))!;
    // 다른 기기가 제어 중인 경우에도 페어링 명부가 그 세션을 바꾸면 안 된다.
    const monitoring = await joinAs(fixture, "monitoring", "roster-monitor");
    expect(snapshot()).toMatchObject({ full: false, monitoring: true });
    await readWithoutChange(monitoring);
    await readWithoutChange(paired);
    const monitoringSession = monitoring.split("; ").find((cookie) => cookie.startsWith("fleet_console_session_"))!;
    expect((await remoteRequest(fixture, "GET", CONSOLE_ROSTER_PATH, undefined, monitoringSession)).status).toBe(200);
    const held = (await readRemoteStatus(fixture)).devices.find((device) => device.device === "roster-monitor")!;
    expect(await revoke(fixture, `access-sessions/${held.sessionHandle}`)).toBe(204);
    expect(snapshot()).toMatchObject({ full: false, monitoring: false });
    await readWithoutChange(paired);
    const head = await remoteRequest(fixture, "HEAD", CONSOLE_ROSTER_PATH, undefined, paired);
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    for (const method of ["POST", "PUT", "DELETE"]) expect((await remoteRequest(fixture, method, CONSOLE_ROSTER_PATH, "{}", paired)).status).toBe(401);
    expect((await remoteRequest(fixture, "GET", "/api/v1/objectives/records", undefined, paired)).status).toBe(401);
    const device = (await readRemoteStatus(fixture)).devices.find((entry) => entry.device === "roster-device")!;
    expect(await revoke(fixture, `paired-devices/${device.id}`)).toBe(204);
    expect((await remoteRequest(fixture, "GET", CONSOLE_ROSTER_PATH, undefined, paired)).status).toBe(401);
    expect(snapshot()).toMatchObject({ full: false, monitoring: false });
  });

  it("serves the commodore's own last reply as the roster preview without opening the read", async () => {
    const fixture = await startFixture({ remote: true });
    const origin = fixture.loopbackEndpoint.replace(/\/$/u, "");
    const created = await fetch(`${origin}/api/v1/commodore/create`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ alias: "명부 사령관" }) });
    expect(created.status).toBe(200);
    const { commodoreId } = await created.json() as { commodoreId: string };
    // 생성 응답이 빈 기록을 캐시하므로, 파일을 쓴 뒤 같은 데이터로 다시 띄워 사이드바와 같은 읽기를 탄다.
    const reply = `알\u0000겠어\n${"나".repeat(180)}`;
    fs.writeFileSync(path.join(fixture.dir, "fleet-home", "console", "commodore", commodoreId, "transcript.jsonl"), `${JSON.stringify({ seq: 1, at: 1, kind: "message", text: "사람은 미리보기가 아니다" })}\n${JSON.stringify({ seq: 2, at: 2, kind: "text", text: reply })}\n`);
    const restarted = await restartFixture(fixture);
    const next = restarted.loopbackEndpoint.replace(/\/$/u, "");
    const response = await fetch(`${next}${CONSOLE_ROSTER_PATH}`, { headers: { Origin: next } });
    expect(response.status).toBe(200);
    const body = await response.json() as { commodores: { preview?: string; commanders?: unknown }[] };
    expect(isConsoleRosterSummary(body)).toBe(true);
    expect(body.commodores[0]?.preview).toBe(`알겠어 ${"나".repeat(155)}`);
    expect(body.commodores[0]?.preview).not.toContain("\u0000");
    expect(JSON.stringify(body)).not.toContain("사람은 미리보기가 아니다");
    expect(body.commodores[0]?.commanders).toBeUndefined();
    expect((await fetch(`${next}${CONSOLE_ROSTER_PATH}`, { headers: { Origin: "http://other.invalid" } })).status).toBe(401);
    expect((await remoteRequest(restarted, "GET", CONSOLE_ROSTER_PATH)).status).toBe(401);
  });

  it("ships the sidebar's own sections on the roster without widening who may read it", async () => {
    const fixture = await startFixture({ remote: true });
    const origin = fixture.loopbackEndpoint.replace(/\/$/u, "");
    const created = await fetch(`${origin}/api/v1/commodore/create`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ alias: "섹션 사령관" }) });
    expect(created.status).toBe(200);
    const { commodoreId } = await created.json() as { commodoreId: string };
    const placed = await fetch(`${origin}/api/v1/commodore/sidebar`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ op: "create", name: "플릿", rowId: commodoreId }) });
    expect(placed.status).toBe(200);
    const { createdSectionId } = await placed.json() as { createdSectionId: string };
    expect((await fetch(`${origin}/api/v1/commodore/sidebar`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ op: "collapse", sectionId: createdSectionId, collapsed: true }) })).status).toBe(200);
    expect((await fetch(`${origin}/api/v1/commodore/sidebar`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ op: "collapse", sectionId: null, collapsed: true }) })).status).toBe(200);
    const response = await fetch(`${origin}${CONSOLE_ROSTER_PATH}`, { headers: { Origin: origin } });
    expect(response.status).toBe(200);
    const body = await response.json() as { sections?: { id: string; name: string; collapsed?: true }[]; unsectionedCollapsed?: true; commodores: { id: string; section?: string }[] };
    expect(isConsoleRosterSummary(body)).toBe(true);
    expect(body.sections).toEqual([{ id: createdSectionId, name: "플릿", collapsed: true }]);
    expect(body.unsectionedCollapsed).toBe(true);
    expect(body.commodores.find((row) => row.id === commodoreId)?.section).toBe(createdSectionId);
    expect((await fetch(`${origin}${CONSOLE_ROSTER_PATH}`, { headers: { Origin: "http://other.invalid" } })).status).toBe(401);
    expect((await remoteRequest(fixture, "GET", CONSOLE_ROSTER_PATH)).status).toBe(401);
  });

  it("admits the console only after the link grant is exchanged", async () => {
    const fixture = await startFixture({ remote: true });
    const token = grantTokenOf(await createLink(fixture));

    const joined = await remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token }));
    expect(joined.status).toBe(204);
    const cookie = joined.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toContain("Secure");

    const session = cookie.split(";")[0]!;
    await expect(remoteRequest(fixture, "GET", "/api/v1/objectives/records", undefined, session)).resolves.toMatchObject({ status: 200 });
    await expect(remoteRequest(fixture, "GET", "/console/", undefined, session)).resolves.toMatchObject({ status: 200 });
    await expect(remoteRequest(fixture, "POST", "/mcp/private", "{}", session)).resolves.toMatchObject({ status: 404 });
  });

  it("preserves remote admission and stream lifetime on a multiplexed HTTP/2 connection", async () => {
    const fixture = await startFixture({ remote: true });
    const authority = `${BIND_HOST}:${fixture.remotePort}`;
    const client = http2.connect(`https://${authority}`, { rejectUnauthorized: false, servername: "" });
    try {
      // :authority만 보내도 소켓의 실제 리스너를 찾아야 한다. 로컬로 오인하면 이 요청이 통과한다.
      expect((await h2Request(client, { ":path": "/api/v1/objectives/records" })).status).toBe(401);
      const joined = await h2Request(client, { ":method": "POST", ":path": "/api/v1/join", "content-type": "application/json" }, JSON.stringify({ token: grantTokenOf(await createLink(fixture)) }));
      expect(joined.status).toBe(204);
      const cookie = cookiesOf(joined);
      const admitted = { ":path": "/api/v1/objectives/records", cookie };
      expect((await h2Request(client, admitted)).status).toBe(200);
      expect((await h2Request(client, { ...admitted, ":authority": "wrong.invalid", host: authority })).status).toBe(403);
      expect((await h2Request(client, { ...admitted, ":authority": authority, host: "wrong.invalid" })).status).toBe(403);
      expect((await h2Request(client, { ...admitted, ":authority": authority, host: authority })).status).toBe(200);
      expect(client.alpnProtocol).toBe("h2");
      expect(client.remoteSettings.enableConnectProtocol).not.toBe(true);

      const open = async (streamPath: string) => {
        const stream = client.request({ ":path": streamPath, origin: `https://${authority}`, cookie });
        const probe = readEventStream(stream);
        const headers = await new Promise<http2.IncomingHttpHeaders>((resolve, reject) => {
          stream.once("response", resolve);
          stream.once("error", reject);
          stream.end();
        });
        expect(headers[":status"]).toBe(200);
        expect(headers.connection).toBeUndefined();
        return probe;
      };
      const objectiveRecords = await open("/api/v1/objectives/events");
      const theme = await open("/api/v1/desktop/theme/events");
      await theme.waitFor("desktop:theme", () => true);
      // 두 SSE가 끝나지 않은 동안에도 같은 세션에서 일반 응답을 받는다.
      expect((await h2Request(client, admitted)).status).toBe(200);
      const device = (await readRemoteStatus(fixture)).devices[0]!;
      expect(await revoke(fixture, `access-sessions/${device.sessionHandle}`)).toBe(204);
      await objectiveRecords.waitForClose();
      await theme.waitForClose();
      expect((await h2Request(client, admitted)).status).toBe(401);

      // 비어 있는 h2 세션과 H1 폴백의 SSE가 남아도 리스너 종료가 끝나야 한다.
      const fallbackCookie = await joinAs(fixture, "full", "fallback");
      const fallback = await openRemoteEvents(fixture, fallbackCookie);
      const closed = new Promise<void>((resolve) => client.once("close", resolve));
      await stopFixture(fixture);
      await closed;
      await fallback.waitForClose();
    } finally {
      client.destroy();
    }
  }, 10_000);

  it("spends a link grant on its first exchange and pairs the device", async () => {
    const fixture = await startFixture({ remote: true });
    const token = grantTokenOf(await createLink(fixture));

    const first = await remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token, device: "once" }));
    expect(first.status).toBe(204);
    expect((first.headers["set-cookie"] ?? []).some((cookie) => cookie.startsWith("fleet_console_pairing_"))).toBe(true);

    const second = await remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token, device: "once" }));
    expect(second.status).toBe(401);
  });

  it("refuses a remote link grant presented to the loopback listener", async () => {
    const fixture = await startFixture({ remote: true });
    const token = grantTokenOf(await createLink(fixture));

    const joined = await fetch(`${fixture.loopbackEndpoint}api/v1/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });

    expect(joined.status).toBe(401);
  });

  it("leaves the join endpoint as the only door a session-less request can reach", async () => {
    const fixture = await startFixture({ remote: true });

    // 브라우저는 자기서명 인증서의 지문을 대조할 수 없어 페어링을 끝낼 수 없다. 설명 표면조차 두지 않는다.
    for (const path of ["/", "/join", "/console/", "/api/v1/state", "/api/v1/objectives/records", "/plugin-runtime/manifest"]) {
      await expect(remoteRequest(fixture, "GET", path)).resolves.toMatchObject({ status: 401 });
    }
    await expect(remoteRequest(fixture, "POST", "/join")).resolves.toMatchObject({ status: 401 });

    // 통과하는 것은 이 하나뿐이며, 자격이 없으면 401로 끝난다 — 열려 있다는 것과 들여보낸다는 것은 다르다.
    await expect(remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token: "not-a-grant" })))
      .resolves.toMatchObject({ status: 401 });
  });

  // 세션 쿠키는 포트로 갈리지 않는다 — 같은 호스트의 다른 포트 페이지가 쿠키를 싣고 보낸 쓰기는 Origin이 달라 거절된다.
  it("refuses a remote write whose Origin is another page's and admits the listener's own or none", async () => {
    const fixture = await startFixture({ remote: true });
    const cookie = await joinAs(fixture, "full", "phone");
    const own = `https://${BIND_HOST}:${fixture.remotePort}`;

    await expect(remoteRequest(fixture, "GET", "/api/v1/browser", undefined, cookie, { origin: `https://${BIND_HOST}:${fixture.remotePort + 1}` }))
      .resolves.toMatchObject({ status: 404 });
    for (const headers of [{ origin: own }, {}] as Record<string, string>[]) {
      const admitted = await remoteRequest(fixture, "GET", "/api/v1/browser", undefined, cookie, headers);
      expect(admitted.status).not.toBe(404);
    }

    // 세션 없이 닿는 join도 같은 규칙이다 — 다른 Origin은 본문을 읽기 전에 403, 같은 Origin·없음은 기존 판정(자격 없음 401).
    const join = JSON.stringify({ token: "not-a-grant" });
    await expect(remoteRequest(fixture, "POST", "/api/v1/join", join, undefined, { origin: `https://${BIND_HOST}:${fixture.remotePort + 1}` }))
      .resolves.toMatchObject({ status: 403 });
    for (const headers of [{ origin: own }, {}] as Record<string, string>[]) {
      await expect(remoteRequest(fixture, "POST", "/api/v1/join", join, undefined, headers)).resolves.toMatchObject({ status: 401 });
    }
  });

  /**
   * 붙어 있는 원격은 하나다. 둘이 동시에 붙으면 커튼이 "누가" 몰고 있는지 하나로 말하지 못하고
   * 회수 버튼의 대상도 갈라진다. 그래서 둘째를 거절하는 대신 첫째를 대신한다 — 페어링 목록은
   * 둘 다 기억하되, 접속 줄은 언제나 하나만 살아 있다.
   */
  it("hands the single remote seat to the newest join and leaves the earlier pairing intact", async () => {
    const realNow = Date.now.bind(Date);
    let clockOffset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
    const fixture = await startFixture({ remote: true });
    const first = await joinAs(fixture, "full", "first");
    const secondLink = await createLink(fixture);

    const secondJoin = await remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({ token: grantTokenOf(secondLink), device: "second" }));
    expect(secondJoin.status).toBe(204);
    const second = cookiesOf(secondJoin);

    // 페어링은 둘이지만 접속은 하나다. 살아 있는 줄은 방금 붙은 쪽이다.
    const held = await readRemoteStatus(fixture);
    expect(held.devices).toHaveLength(2);
    expect(held.devices.filter((entry) => entry.sessionHandle !== null).map((entry) => entry.device)).toEqual(["second"]);

    // 프레임을 못 받은 기기도 자기 페어링 쿠키로 사유만 받는다. 다른 세션의 정보는 실리지 않는다.
    const ended = await remoteRequest(fixture, "GET", "/api/v1/objectives/records", undefined, first);
    expect(ended.status).toBe(401);
    expect(JSON.parse(ended.body)).toEqual({ error: "unauthorized", reason: "superseded" });
    const secondPairing = second.split("; ").find((cookie) => cookie.startsWith("fleet_console_pairing_"))!;
    for (const cookie of [undefined, "unrelated=secret", secondPairing]) {
      const denied = await remoteRequest(fixture, "GET", "/api/v1/objectives/records", undefined, cookie);
      expect(denied.status).toBe(401);
      expect(JSON.parse(denied.body)).toEqual({ error: "unauthorized" });
    }
    const deniedStatus = await readRemoteStatus(fixture);
    expect(deniedStatus.rejectedJoins.count).toBe(0);
    expect(deniedStatus.devices.find((entry) => entry.device === "first")!.lastSeenAt)
      .toBe(held.devices.find((entry) => entry.device === "first")!.lastSeenAt);

    // 명시적 재오픈은 성공하고 그 페어링의 사유를 지운다. 옛 세션 쿠키는 여전히 죽어 있다.
    const resumed = await remoteRequest(fixture, "POST", "/api/v1/join", JSON.stringify({}), first);
    expect(resumed.status).toBe(204);
    const current = cookiesOf(resumed);
    const cleared = await remoteRequest(fixture, "GET", "/api/v1/objectives/records", undefined, first);
    expect(JSON.parse(cleared.body)).toEqual({ error: "unauthorized" });
    const resumedStatus = await readRemoteStatus(fixture);
    expect(resumedStatus.devices.filter((entry) => entry.sessionHandle !== null).map((entry) => entry.device)).toEqual(["first"]);

    // 주인 회수도 스트림을 닫고 같은 재연결 표면에 사유를 남긴다.
    const device = resumedStatus.devices.find((entry) => entry.device === "first")!;
    const stream = await openRemoteEvents(fixture, current);
    expect(await revoke(fixture, `access-sessions/${device.sessionHandle}`)).toBe(204);
    await expect(stream.waitFor("control:reclaimed", () => true)).resolves.toEqual({ reason: "reclaimed" });
    await stream.waitForClose();
    const reclaimed = await remoteRequest(fixture, "GET", "/api/v1/objectives/records", undefined, current);
    expect(reclaimed.status).toBe(401);
    expect(JSON.parse(reclaimed.body)).toEqual({ error: "unauthorized", reason: "reclaimed" });

    // 재시작은 메모리 사유를 잊어 vanished가 된다. 페어링은 남고 다시 join할 수 있다.
    const restarted = await restartFixture(fixture);
    const vanished = await remoteRequest(restarted, "GET", "/api/v1/objectives/records", undefined, current);
    expect(vanished.status).toBe(401);
    expect(JSON.parse(vanished.body)).toEqual({ error: "unauthorized" });
    const reopened = await remoteRequest(restarted, "POST", "/api/v1/join", "{}", current);
    expect(reopened.status).toBe(204);
    let reopenedCookie = cookiesOf(reopened);
    await expect(remoteRequest(restarted, "GET", "/api/v1/objectives/records", undefined, reopenedCookie)).resolves.toMatchObject({ status: 200 });

    // 유휴 만료는 그 세션의 모든 장수명 채널을 함께 닫는다 — Objective 스트림만이 아니라 다른 SSE도.
    // 루프백 구독은 그대로 남고, 페어링된 기기는 말없이 다시 붙는다.
    const writeLocal = async (route: string, method: string, body: unknown) => {
      const response = await fetch(`${restarted.loopbackEndpoint}api/v1/${route}`, {
        method, headers: { Origin: restarted.loopbackEndpoint.replace(/\/$/u, ""), "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      expect(response.ok).toBe(true);
      return response.json();
    };
    const grant = await writeLocal("theaters/folder-grants", "POST", { path: restarted.dir });
    const { commodoreId } = await writeLocal("commodore/create", "POST", { alias: "Remote seat fixture" });
    const { theaterId } = await writeLocal("commodore/theaters/add", "POST", { commodoreId, folderGrantId: grant.folderGrantId });
    const { objectiveRecord } = await writeLocal("objectives/records", "POST", { commodoreId, theaterId, type: "agent", pluginId: null, title: "before-idle", payload: {} });
    const idleStream = await openRemoteEvents(restarted, reopenedCookie);
    const secondIdleStream = await openRemoteEvents(restarted, reopenedCookie);
    const localStream = await openLoopbackEvents(restarted);
    const idleTheme = await openRemoteEvents(restarted, reopenedCookie, "/api/v1/desktop/theme/events");
    const localTheme = await openLoopbackEvents(restarted, "/api/v1/desktop/theme/events");
    try {
      await idleTheme.waitFor("desktop:theme", () => true);
      await localTheme.waitFor("desktop:theme", () => true);
      clockOffset += 61 * 60_000;
      await writeLocal(`objectives/records/${objectiveRecord.id}`, "PATCH", { title: "after-idle" });
      await idleStream.waitForClose();
      await secondIdleStream.waitForClose();
      for (const stream of [idleStream, secondIdleStream]) {
        expect(stream.seen("objective:changed")).toBe(0);
        expect(stream.seen("control:reclaimed")).toBe(0);
      }
      await localStream.waitFor("objective:changed", (data) => data.objectiveRecord.title === "after-idle");
      // 만료는 위 전송에서 이미 판정됐다. 테마 스트림은 자기 방송을 기다리지 않고 같은 종료 신호로 닫혀 있어야 한다.
      await idleTheme.waitForClose();
      await writeLocal("settings/global", "PUT", { theme: "light" });
      await localTheme.waitFor("desktop:theme", (data) => data.theme === "light");
      expect(idleTheme.seen("desktop:theme")).toBe(1);
      const expired = await remoteRequest(restarted, "GET", "/api/v1/objectives/records", undefined, reopenedCookie);
      expect(expired.status).toBe(401);
      expect(JSON.parse(expired.body)).toEqual({ error: "unauthorized" });
      const rejoined = await remoteRequest(restarted, "POST", "/api/v1/join", "{}", reopenedCookie);
      expect(rejoined.status).toBe(204);
      reopenedCookie = cookiesOf(rejoined);
      const freshStream = await openRemoteEvents(restarted, reopenedCookie);
      try {
        await writeLocal(`objectives/records/${objectiveRecord.id}`, "PATCH", { title: "after-rejoin" });
        await freshStream.waitFor("objective:changed", (data) => data.objectiveRecord.title === "after-rejoin");
        expect(idleStream.seen("objective:changed")).toBe(0);
      } finally { freshStream.close(); }
    } finally {
      localStream.close();
      idleStream.close();
      secondIdleStream.close();
      idleTheme.close();
      localTheme.close();
    }

    // 언페어링은 돌아올 권한까지 걷는다. 남은 쿠키에는 사유도 재합류도 주지 않는다.
    const reopenedDevice = (await readRemoteStatus(restarted)).devices.find((entry) => entry.device === "first")!;
    expect(await revoke(restarted, `access-sessions/${reopenedDevice.sessionHandle}`)).toBe(204);
    expect(await revoke(restarted, `paired-devices/${device.id}`)).toBe(204);
    const unpaired = await remoteRequest(restarted, "GET", "/api/v1/objectives/records", undefined, reopenedCookie);
    expect(JSON.parse(unpaired.body)).toEqual({ error: "unauthorized" });
    await expect(remoteRequest(restarted, "POST", "/api/v1/join", "{}", reopenedCookie)).resolves.toMatchObject({ status: 401 });
  });

  /**
   * 창은 뜨자마자 "돌아갈 곳"을 한 번 묻는다. 재기동한 콘솔은 앞선 게시를 잊었으므로 셸이 다시
   * 게시하는데, 그 순간이 물음보다 늦으면 첫 답은 빈손이다 — 그 뒤늦은 게시는 이미 붙어 있는
   * 그 창의 스트림으로 가야 하고, 그 뒤 다시 붙는 창은 붙는 순간 그 집을 받아야 한다.
   */
  it("carries a home published after the window attached to that window's stream, and to its next attach", async () => {
    const fixture = await startFixture({ remote: true });
    const cookie = await joinAs(fixture, "full", "desktop");
    const origin = `https://${BIND_HOST}:${fixture.remotePort}`;
    const home = "http://127.0.0.1:50692";
    const attached = await openRemoteEvents(fixture, cookie, undefined, true);
    const localDesktop = await openLoopbackEvents(fixture, undefined, true);
    await expect(localDesktop.waitFor("computer-capture:state", () => true)).resolves.toEqual({ target: null, unavailableObjectiveId: null });
    localDesktop.close();

    const published = await remoteRequest(fixture, "PUT", "/api/v1/desktop/shell", JSON.stringify({ homeOrigin: home }), cookie, { origin });
    expect(published.status).toBe(204);
    await expect(attached.waitFor("desktop:shell", (data) => data.homeOrigin === home)).resolves.toEqual({ homeOrigin: home });
    // 원격 Desktop은 자기 셸 상태만 받고 로컬 Computer Use의 대상 스냅샷은 받지 않는다.
    expect(attached.seen("computer-capture:state")).toBe(0);
    attached.close();

    const reattached = await openRemoteEvents(fixture, cookie, undefined, true);
    await expect(reattached.waitFor("desktop:shell", (data) => data.homeOrigin === home)).resolves.toEqual({ homeOrigin: home });
    expect(reattached.seen("computer-capture:state")).toBe(0);
    reattached.close();
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

function readEventStream(response: Readable): EventProbe {
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

function openLoopbackEvents(fixture: Fixture, streamPath = "/api/v1/objectives/events", desktop = false): Promise<EventProbe> {
  const url = new URL(`${fixture.loopbackEndpoint}${streamPath.slice(1)}`);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: url.hostname, port: Number(url.port), path: url.pathname, method: "GET", headers: { origin: url.origin, ...(desktop ? { "user-agent": "Electron/42" } : {}) } }, (response) => resolve(readEventStream(response)));
    request.on("error", reject);
    request.end();
  });
}

function openRemoteEvents(fixture: Fixture, cookie: string, streamPath = "/api/v1/objectives/events", desktop = false): Promise<EventProbe> {
  return new Promise((resolve, reject) => {
    const request = https.request({
      host: BIND_HOST,
      port: fixture.remotePort,
      path: streamPath,
      method: "GET",
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
      headers: { host: `${BIND_HOST}:${fixture.remotePort}`, origin: `https://${BIND_HOST}:${fixture.remotePort}`, cookie, ...(desktop ? { "user-agent": "Electron/42" } : {}) },
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

function h2Request(client: http2.ClientHttp2Session, headers: http2.OutgoingHttpHeaders, body?: string): Promise<{ status: number; headers: http2.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = client.request(headers);
    let responseHeaders: http2.IncomingHttpHeaders = {};
    const chunks: Buffer[] = [];
    request.once("response", (received) => { responseHeaders = received; });
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("error", reject);
    request.once("end", () => resolve({ status: Number(responseHeaders[":status"]), headers: responseHeaders, body: Buffer.concat(chunks).toString("utf8") }));
    request.end(body);
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
  const lock = readConsoleLockFile(path.join(dir, "console.lock"))!;
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

describe("console roster commanders", () => {
  const source = (patch: Partial<RosterCommanderSource> & Pick<RosterCommanderSource, "id">): RosterCommanderSource => ({
    title: patch.title ?? patch.id, createdAt: 1, activityAt: 1, dueDate: null, order: 0, groupId: null, done: 1, total: 4, run: "quiet", waiting: false, ...patch,
  });

  it("keeps in-progress rows in sidebar order, within the contract", () => {
    expect(rosterCommanderIncluded({ removed: false, archived: false, done: false, fresh: true, personWaiting: false })).toBe(false);
    expect(rosterCommanderIncluded({ removed: false, archived: false, done: false, fresh: true, personWaiting: true })).toBe(true);
    expect(rosterCommanderIncluded({ removed: false, archived: false, done: true, fresh: false, personWaiting: false })).toBe(false);
    expect(rosterCommanderIncluded({ removed: false, archived: false, done: false, fresh: false, personWaiting: false })).toBe(true);
    expect(consoleRosterRun(true, ["running"])).toBe("waiting");
    expect(consoleRosterRun(false, ["idle", "awaiting"])).toBe("waiting");
    expect(consoleRosterRun(false, ["background"])).toBe("working");
    expect(consoleRosterRun(false, [null])).toBe("quiet");
    expect(consoleRosterPreview("알\u0000겠어")).toBe("알겠어");
    expect(consoleRosterPreview("\u0000")).toBeUndefined();

    const waiting = source({ id: "old", activityAt: 10, waiting: true, run: "waiting", done: 2, total: 5 });
    const recent = source({ id: "new", activityAt: 20, title: `줄\n${"가".repeat(200)}` });
    const ordered = consoleRosterCommanders([recent, waiting], [], ROSTER_SORT_DEFAULT);
    expect(ordered.commanders.map((row) => row.id)).toEqual(["old", "new"]);
    expect(ordered.commanders[0]).toMatchObject({ done: 2, total: 5, run: "waiting" });
    expect(ordered.commanders[1]?.title.length).toBeLessThanOrEqual(120);
    expect(ordered.commanders[1]?.title).not.toMatch(/[\n\u0000]/u);

    const many = consoleRosterCommanders(Array.from({ length: 9 }, (_, index) => source({ id: `c${index}`, activityAt: index })), [], ROSTER_SORT_DEFAULT);
    expect(many.commanders.map((row) => row.id)).toEqual(["c8", "c7", "c6", "c5", "c4", "c3", "c2", "c1"]);
    expect(many.moreCommanders).toBe(1);
    const grouped = consoleRosterCommanders(
      [source({ id: "a", groupId: "ga", activityAt: 50 }), source({ id: "b", groupId: "gb", activityAt: 10 })],
      [{ id: "ga", order: 1, createdAt: 1 }, { id: "gb", order: 0, createdAt: 1 }],
      { ...ROSTER_SORT_DEFAULT, grouped: true },
    );
    expect(grouped.commanders.map((row) => row.id)).toEqual(["b", "a"]);
    expect(consoleRosterCommanders([source({ id: "face", look: { base: 4, tone: "teal" } })], [], ROSTER_SORT_DEFAULT).commanders[0]?.look).toEqual({ base: 4, tone: "teal" });
    expect(consoleRosterLook(null)).toBeNull();
    expect(consoleRosterLook({ base: -1, tone: null })).toBeNull();
    expect(consoleRosterSections(undefined)).toEqual({});
    expect(consoleRosterSections({ sections: [], unsectionedCollapsed: true })).toEqual({});
    expect(consoleRosterSections({ sections: [{ id: "s", name: "플릿", collapsed: false }], unsectionedCollapsed: false })).toEqual({ sections: [{ id: "s", name: "플릿" }] });
    const placed = consoleRosterSections({ sections: [{ id: "s", name: "플릿", collapsed: true }], unsectionedCollapsed: true });
    expect(placed).toEqual({ sections: [{ id: "s", name: "플릿", collapsed: true }], unsectionedCollapsed: true });
    expect(isConsoleRosterSummary({ v: 1, commodores: [{ id: "commodore-1", name: "보리", look: null, run: "quiet", section: "s", commanders: many.commanders, moreCommanders: many.moreCommanders }], more: 0, ...placed })).toBe(true);
  });
});

function createFakeConsoleRuntime(): unknown {
  const handlers = new Set<(event: unknown) => void>();
  return {
    carrierRuntime: { jobs: { streaming: { register(callback: (event: unknown) => void) { handlers.add(callback); return () => handlers.delete(callback); } } } },
    cleanup: vi.fn(async () => undefined),
  };
}
