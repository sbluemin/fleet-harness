import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { consoleTarget, createRemoteBridge } from "../src/remote-bridge.js";

const LOCAL = "http://127.0.0.1:4310";
const REMOTE = "https://100.84.12.7:6768";
const FINGERPRINT = "8D3FBB2A855053305C32280A2ABB566FFF9C5B14C353AE0527092ED476CBB70F";

function handoff(overrides: Record<string, unknown> = {}): Response {
  return Response.json({ origin: REMOTE, hostname: "100.84.12.7", port: 6768, fingerprint: FINGERPRINT, token: "grant-token", ...overrides });
}

/** 무엇이 어떤 차례로 일어났는지가 이 다리의 계약이라, 호출을 한 줄로 기록해 둔다. */
function createHarness(options: { readonly responses?: (path: string) => Response; readonly confirm?: () => Promise<void>; readonly load?: () => Promise<void>; readonly verify?: () => Response } = {}) {
  const trace: string[] = [];
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const notices: Array<{ title: string; body: string }> = [];
  let current: string | null = LOCAL;

  const policy = {
    activateConsoleOrigin: (origin: string) => { trace.push(`activate:${origin}`); current = origin; },
    currentConsoleOrigin: () => current,
    stageConsoleOrigin: (origin: string) => trace.push(`stage:${origin}`),
    commitConsoleOrigin: () => { trace.push("commit"); },
    cancelPendingConsoleOrigin: () => trace.push("cancel"),
    admitRemoteConsoleOrigin: (origin: string) => trace.push(`admit:${origin}`),
    withdrawRemoteConsoleOrigin: (origin: string) => trace.push(`withdraw:${origin}`),
  };
  const pins = {
    pin: (hostname: string) => trace.push(`pin:${hostname}`),
    unpin: (hostname: string) => trace.push(`unpin:${hostname}`),
    clear: () => trace.push("clear"),
  };
  const sessionFetch = vi.fn(async (url: string) => {
    if (url.endsWith("/console/")) {
      trace.push(`verify:${url}`);
      return options.verify ? options.verify() : new Response("<!doctype html>", { status: 200 });
    }
    trace.push(`join:${url}`);
    return new Response(null, { status: 204 });
  });

  const bridge = createRemoteBridge({
    pins,
    policy: () => policy,
    sessionFetch,
    localFetch: (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      const path = new URL(url).pathname;
      trace.push(`ask:${path}`);
      return options.responses ? options.responses(path) : handoff();
    }) as never,
    localOrigin: () => LOCAL,
    loadConsole: async (url) => {
      trace.push(`load:${url}`);
      if (options.load) await options.load();
    },
    notify: (notice) => notices.push({ title: notice.title, body: notice.body }),
    confirmIdentity: options.confirm ?? (async () => { trace.push("confirm"); }),
  });

  return { bridge, trace, requests, notices, sessionFetch, setCurrent: (origin: string | null) => { current = origin; } };
}

describe("console target", () => {
  it.each([
    [`${REMOTE}/console/`, REMOTE],
    [`${REMOTE}/console/settings`, REMOTE],
    // 돌아오는 길도 이 다리를 거쳐야 한다 — window policy가 활성 origin 밖을 막기 때문이다.
    [`${LOCAL}/console/`, LOCAL],
    // 이 기계에서 발견한 다른 콘솔도 마찬가지다. 가로채지 않으면 policy가 막아 클릭이 무음으로 죽는다.
    ["http://127.0.0.1:50000/console/", "http://127.0.0.1:50000"],
  ])("claims %s", (url, origin) => {
    expect(consoleTarget(url, LOCAL)).toBe(origin);
  });

  it.each([
    ["another machine's plaintext console", "http://100.84.12.7:6768/console/"],
    ["a path outside the console", `${REMOTE}/join`],
    ["the bare origin", REMOTE],
    ["a non-url", "not a url"],
  ])("leaves %s alone", (_label, url) => {
    expect(consoleTarget(url, LOCAL)).toBeNull();
  });

  it("claims no loopback console when the shell has none of its own", () => {
    expect(consoleTarget(`${LOCAL}/console/`, null)).toBeNull();
  });
});

describe("remote bridge", () => {
  it("confirms the certificate before Chromium is ever pointed at that host", async () => {
    const harness = createHarness();

    await harness.bridge.open(REMOTE);

    // 대조가 핀·허용·적재보다 먼저다 — 어긋난 판정이 한 번 캐시에 들어가면 재시작 전까지 살아남는다.
    expect(harness.trace).toEqual([
      "ask:/api/v1/desktop/handoff",
      "confirm",
      "pin:100.84.12.7",
      `admit:${REMOTE}`,
      `stage:${REMOTE}`,
      `join:${REMOTE}/api/v1/join`,
      // 창을 보내기 전에 콘솔이 정말 콘솔을 내주는지 확인한다 — loadURL은 401 본문도 성공으로 되돌린다.
      `verify:${REMOTE}/console/`,
      `load:${REMOTE}/console/`,
      "commit",
    ]);
  });

  it("asks the local console with the origin its write gate requires", async () => {
    const harness = createHarness();

    await harness.bridge.open(REMOTE);

    const [request] = harness.requests;
    expect(request?.url).toBe(`${LOCAL}/api/v1/desktop/handoff`);
    expect((request?.init.headers as Record<string, string>).Origin).toBe(LOCAL);
    expect(request?.init.body).toBe(JSON.stringify({ origin: REMOTE }));
  });

  it("skips the join when the grant was already spent, and still opens the console", async () => {
    const harness = createHarness({ responses: () => handoff({ token: null }) });

    await harness.bridge.open(REMOTE);

    expect(harness.trace).not.toContain(`join:${REMOTE}/api/v1/join`);
    expect(harness.trace).toContain(`load:${REMOTE}/console/`);
  });

  it("leaves no trust behind when the certificate does not match", async () => {
    const harness = createHarness({ confirm: async () => { throw new Error("remote_link_fingerprint_mismatch"); } });

    await expect(harness.bridge.open(REMOTE)).rejects.toThrow("remote_link_fingerprint_mismatch");

    expect(harness.trace).toEqual(["ask:/api/v1/desktop/handoff"]);
  });

  it("rolls the pin and the admitted origin back when the console fails to load", async () => {
    const harness = createHarness({ load: async () => { throw new Error("ERR_CONNECTION_REFUSED"); } });

    await expect(harness.bridge.open(REMOTE)).rejects.toThrow("ERR_CONNECTION_REFUSED");

    expect(harness.trace).toContain("cancel");
    expect(harness.trace).toContain(`withdraw:${REMOTE}`);
    expect(harness.trace).toContain("unpin:100.84.12.7");
    expect(harness.trace).not.toContain("commit");
  });

  it("never sends the window to a console that answers with an error document", async () => {
    const harness = createHarness({ verify: () => Response.json({ error: "unauthorized" }, { status: 401 }) });

    await expect(harness.bridge.open(REMOTE)).rejects.toThrow("remote_host_session_expired");

    // 창은 움직이지 않았고, 신뢰도 남지 않았다.
    expect(harness.trace).not.toContain(`load:${REMOTE}/console/`);
    expect(harness.trace).toContain(`withdraw:${REMOTE}`);
    expect(harness.trace).toContain("unpin:100.84.12.7");
  });

  it("brings the window home when it lands on an error document anyway", async () => {
    const contents = new EventEmitter();
    const harness = createHarness();
    harness.bridge.attach(contents as never);
    harness.setCurrent(REMOTE);

    contents.emit("did-navigate", {}, `${REMOTE}/console/`, 401);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.trace).toContain(`withdraw:${REMOTE}`);
    expect(harness.trace).toContain(`load:${LOCAL}/console/`);
    expect(harness.notices[0]?.body).toContain("no longer recognises this device");
  });

  it("refuses a host the local console no longer lists", async () => {
    const harness = createHarness({ responses: () => Response.json({ error: "remote_host_unknown" }, { status: 404 }) });

    await expect(harness.bridge.open(REMOTE)).rejects.toThrow("remote_host_unknown");
  });

  it("hands a link over without reading it, then opens what the console resolved", async () => {
    const link = "fleet://join?code=eyJ2IjoxfQ";
    const harness = createHarness({
      responses: (path) => (path === "/api/v1/remote-hosts" ? Response.json({ host: { origin: REMOTE } }, { status: 201 }) : handoff()),
    });

    await harness.bridge.receiveLink(link);

    expect(harness.requests[0]?.url).toBe(`${LOCAL}/api/v1/remote-hosts`);
    expect(harness.requests[0]?.init.body).toBe(JSON.stringify({ link }));
    expect(harness.trace).toContain(`load:${REMOTE}/console/`);
  });

  it("carries the console's own refusal back to the person who pasted the link", async () => {
    const harness = createHarness({ responses: () => Response.json({ error: "remote_host_fingerprint_mismatch" }, { status: 409 }) });

    await harness.bridge.receiveLink("fleet://join?code=eyJ2IjoxfQ").catch((error: unknown) => harness.bridge.report(error));

    expect(harness.notices[0]?.body).toContain("different certificate");
  });

  it("intercepts a jump to another console and lets movement inside the current one pass", async () => {
    const contents = new EventEmitter();
    const harness = createHarness();
    harness.bridge.attach(contents as never);

    const inside = { preventDefault: vi.fn() };
    harness.setCurrent(REMOTE);
    contents.emit("will-navigate", inside, `${REMOTE}/console/settings`, false, true);
    expect(inside.preventDefault).not.toHaveBeenCalled();

    const jump = { preventDefault: vi.fn() };
    harness.setCurrent(LOCAL);
    contents.emit("will-navigate", jump, `${REMOTE}/console/`, false, true);
    expect(jump.preventDefault).toHaveBeenCalledOnce();
  });

  it("ignores a subframe trying to move the window", () => {
    const contents = new EventEmitter();
    const harness = createHarness();
    harness.bridge.attach(contents as never);

    const subframe = { preventDefault: vi.fn() };
    contents.emit("will-navigate", subframe, `${REMOTE}/console/`, false, false);

    expect(subframe.preventDefault).not.toHaveBeenCalled();
    expect(harness.trace).toEqual([]);
  });

  it("goes back to the shell's own console without a pin, a grant, or the host list", async () => {
    const harness = createHarness();
    harness.setCurrent(REMOTE);

    await harness.bridge.open(LOCAL);

    expect(harness.trace).toEqual([`activate:${LOCAL}`, `load:${LOCAL}/console/`]);
    expect(harness.requests).toEqual([]);
    expect(harness.sessionFetch).not.toHaveBeenCalled();
  });

  it("intercepts the way home, which the window policy would otherwise block", () => {
    const contents = new EventEmitter();
    const harness = createHarness();
    harness.bridge.attach(contents as never);
    harness.setCurrent(REMOTE);

    const home = { preventDefault: vi.fn() };
    contents.emit("will-navigate", home, `${LOCAL}/console/`, false, true);

    expect(home.preventDefault).toHaveBeenCalledOnce();
  });

  it("opens another console on this machine only after the local console confirms it found one", async () => {
    const DISCOVERED = "http://127.0.0.1:50000";
    const harness = createHarness({
      responses: (path) => (path === "/api/v1/local-consoles"
        ? Response.json({ consoles: [{ origin: DISCOVERED, version: "1.51.0", owner: "cli", distro: null }] })
        : handoff()),
    });

    await harness.bridge.open(DISCOVERED);

    // 핀도 자격도 거치지 않는다 — 같은 기계이므로 확인만으로 충분하다.
    expect(harness.trace).toEqual(["ask:/api/v1/local-consoles", `activate:${DISCOVERED}`, `load:${DISCOVERED}/console/`]);
  });

  /**
   * 원격 콘솔이 서빙한 페이지가 `http://127.0.0.1:<임의>`로 항해를 걸면 그 주소는 보는 사람의
   * 기계에 있는 전혀 다른 서비스를 가리킨다. 발견 목록에 없는 곳으로는 창을 보내지 않는다.
   */
  it("refuses a loopback port the local console never reported", async () => {
    const harness = createHarness({
      responses: (path) => (path === "/api/v1/local-consoles" ? Response.json({ consoles: [] }) : handoff()),
    });

    await expect(harness.bridge.open("http://127.0.0.1:9999")).rejects.toThrow("remote_host_unknown");

    expect(harness.trace).toEqual(["ask:/api/v1/local-consoles"]);
  });

  it("stops listening once disposed", () => {
    const contents = new EventEmitter();
    const harness = createHarness();
    harness.bridge.attach(contents as never);

    harness.bridge.dispose();

    expect(contents.listenerCount("will-navigate")).toBe(0);
  });
});
