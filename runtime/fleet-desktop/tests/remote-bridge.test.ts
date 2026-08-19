import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { consoleTarget, createRemoteBridge, pickerSurfaceOf } from "../src/remote-bridge.js";

const LOCAL = "http://127.0.0.1:4310";
const REMOTE = "https://100.84.12.7:6768";
const FINGERPRINT = "8D3FBB2A855053305C32280A2ABB566FFF9C5B14C353AE0527092ED476CBB70F";

function handoff(overrides: Record<string, unknown> = {}): Response {
  return Response.json({ origin: REMOTE, hostname: "100.84.12.7", port: 6768, fingerprint: FINGERPRINT, token: "grant-token", ...overrides });
}

/** 무엇이 어떤 차례로 일어났는지가 이 다리의 계약이라, 호출을 한 줄로 기록해 둔다. */
function createHarness(options: { readonly responses?: (path: string) => Response; readonly confirm?: () => Promise<void>; readonly load?: (url: string) => Promise<void>; readonly verify?: () => Response; readonly picker?: () => Promise<void> } = {}) {
  const trace: string[] = [];
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const notices: Array<{ title: string; body: string }> = [];
  let current: string | null = LOCAL;

  let pending: string | null = null;
  const policy = {
    activateConsoleOrigin: (origin: string) => { trace.push(`activate:${origin}`); current = origin; pending = null; },
    currentConsoleOrigin: () => current,
    // 실제 정책과 같은 의미론으로 둔다 — 확정 전까지 활성 origin은 옛 콘솔 그대로다.
    stageConsoleOrigin: (origin: string) => { trace.push(`stage:${origin}`); pending = origin; },
    commitConsoleOrigin: () => { trace.push("commit"); if (pending !== null) current = pending; pending = null; },
    cancelPendingConsoleOrigin: () => { trace.push("cancel"); pending = null; },
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
      if (options.load) await options.load(url);
    },
    openPicker: async (url: string) => {
      trace.push(`picker:open:${url}`);
      if (options.picker) await options.picker();
    },
    closePicker: () => trace.push("picker:close"),
    notify: (notice) => notices.push({ title: notice.title, body: notice.body }),
    confirmIdentity: options.confirm ?? (async () => { trace.push("confirm"); }),
  });

  return {
    bridge,
    trace,
    requests,
    notices,
    sessionFetch,
    currentOrigin: () => current,
    setCurrent: (origin: string | null) => { current = origin; },
  };
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

  /**
   * 링크의 1회용 자격은 처음 한 번만 실려 온다. 그 뒤로 token이 비어 와도 조인을 건너뛰지
   * 않는다 — 그 요청이 창의 페어링 쿠키를 세션으로 바꾸는 유일한 자리이고, 제어권을
   * 회수당했거나 접속이 만료된 뒤 돌아오는 길이 바로 그것이다. 건너뛰면 그 기기는 링크를
   * 새로 받기 전에는 영영 돌아오지 못한다.
   */
  it("still joins when the grant was already spent, so a paired device can resume", async () => {
    const harness = createHarness({ responses: () => handoff({ token: null }) });

    await harness.bridge.open(REMOTE);

    expect(harness.trace).toContain(`join:${REMOTE}/api/v1/join`);
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
    // 세션이 끝난 것과 페어링을 잃은 것은 다른 사실이다 — 재시작 뒤에는 링크가 아니라
    // "다시 열기"가 답이므로, 안내가 링크를 구하러 보내면 안 된다.
    expect(harness.notices[0]?.body).toContain("ended this session");
    expect(harness.notices[0]?.body).not.toContain("fresh access link");
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

    expect(harness.trace).toEqual([`stage:${LOCAL}`, `load:${LOCAL}/console/`, "commit"]);
    expect(harness.requests).toEqual([]);
    expect(harness.sessionFetch).not.toHaveBeenCalled();
  });

  /**
   * 적재가 실패했는데 활성 origin만 옮겨 두면, 정책은 새 콘솔을 창은 옛 콘솔을 가리킨 채
   * 갈라진다 — 그 창은 눈앞의 화면 안에서조차 항해하지 못한다.
   */
  it("leaves the window on the console it can still see when the load fails", async () => {
    const harness = createHarness({ load: async () => { throw new Error("ERR_CONNECTION_REFUSED"); } });
    harness.setCurrent(REMOTE);

    await expect(harness.bridge.open(LOCAL)).rejects.toThrow("ERR_CONNECTION_REFUSED");

    expect(harness.trace).toEqual([`stage:${LOCAL}`, `load:${LOCAL}/console/`, "cancel"]);
    expect(harness.currentOrigin()).toBe(REMOTE);
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
    expect(harness.trace).toEqual(["ask:/api/v1/local-consoles", `stage:${DISCOVERED}`, `load:${DISCOVERED}/console/`, "commit"]);
  });

  /**
   * 예약 자리는 정책에 하나뿐이다. 앞선 시도가 늦게 끝나면서 뒤에 온 시도의 예약을 확정하면,
   * 정책은 창이 가 있지도 않은 콘솔을 가리킨 채 남는다 — 그 창은 눈앞의 화면에서 움직이지 못한다.
   */
  it("does not let a slower open commit the origin a newer one staged", async () => {
    const FIRST = "http://127.0.0.1:50001";
    const SECOND = "http://127.0.0.1:50002";
    const gates = new Map<string, () => void>();
    const harness = createHarness({
      responses: (path) => (path === "/api/v1/local-consoles"
        ? Response.json({
          consoles: [
            { origin: FIRST, version: "1.52.0", owner: "cli", distro: null },
            { origin: SECOND, version: "1.52.0", owner: "cli", distro: null },
          ],
        })
        : handoff()),
      load: (url) => new Promise<void>((resolve) => { gates.set(url, resolve); }),
    });

    const first = harness.bridge.open(FIRST);
    await vi.waitFor(() => expect(gates.has(`${FIRST}/console/`)).toBe(true));
    const second = harness.bridge.open(SECOND);
    await vi.waitFor(() => expect(gates.has(`${SECOND}/console/`)).toBe(true));

    // 먼저 시작한 쪽이 늦게 끝난다.
    gates.get(`${FIRST}/console/`)!();
    await first;
    gates.get(`${SECOND}/console/`)!();
    await second;

    expect(harness.trace.filter((entry) => entry === "commit")).toHaveLength(1);
    expect(harness.currentOrigin()).toBe(SECOND);
  });

  /**
   * WSL 안의 콘솔은 루프백 주소로 열리지만 집이 아니다. 그 화면에서 목록을 펴 달라는 신호는
   * 원격에서 온 것과 똑같이 가로채여 덮개로 가야 한다 — 창째로 집에 돌아가 버리면 사용자는
   * 보고 있던 콘솔을 잃는다.
   */
  it("overlays home's list when the signal comes from a loopback console that is not home", () => {
    const contents = new EventEmitter();
    const harness = createHarness();
    harness.bridge.attach(contents as never);
    harness.setCurrent("http://127.0.0.1:2253");

    const event = { preventDefault: vi.fn() };
    contents.emit("will-navigate", event, `${LOCAL}/console/?desktop-surface=host-picker&at=${encodeURIComponent("http://127.0.0.1:2253")}`, false, true);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(harness.trace).toEqual([`picker:open:${LOCAL}/console/?desktop-surface=host-picker&at=${encodeURIComponent("http://127.0.0.1:2253")}`]);
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

const PICKER_OPEN_URL = `${LOCAL}/console/?desktop-surface=host-picker&at=${encodeURIComponent(REMOTE)}`;
const PICKER_DISMISS_URL = `${LOCAL}/console/?desktop-surface=host-picker-dismiss`;

/** 항해 하나가 두 뜻으로 읽히면 안 된다 — 목록을 펴는 신호와, 창째로 집에 가는 길. */
describe("host picker surface", () => {
  it.each([
    [PICKER_OPEN_URL, "open"],
    [PICKER_DISMISS_URL, "dismiss"],
  ])("reads %s as %s", (url, surface) => {
    expect(pickerSurfaceOf(url, LOCAL)).toBe(surface);
  });

  it.each([
    ["a plain console url", `${LOCAL}/console/`],
    ["an unknown surface", `${LOCAL}/console/?desktop-surface=whatever`],
    // 원격 콘솔이 자기 주소로 신호를 흉내 내도 집의 목록은 열리지 않는다.
    ["the same query on another origin", `${REMOTE}/console/?desktop-surface=host-picker`],
    ["a path outside the console", `${LOCAL}/join?desktop-surface=host-picker`],
    ["a non-url", "not a url"],
  ])("refuses %s", (_label, url) => {
    expect(pickerSurfaceOf(url, LOCAL)).toBeNull();
  });

  it("claims no surface when the shell has no console of its own", () => {
    expect(pickerSurfaceOf(PICKER_OPEN_URL, null)).toBeNull();
  });

  /**
   * 이 판정이 consoleTarget보다 늦으면 목록이 열리는 대신 창이 집으로 넘어간다 — 고치려던
   * 2단 동선 그대로다. 리스너 등록 순서가 아니라 이 다리 안의 순서가 그것을 정한다.
   */
  it("opens the home list instead of sending the window home", async () => {
    const contents = new EventEmitter();
    const harness = createHarness();
    harness.bridge.attach(contents as never);
    harness.setCurrent(REMOTE);
    let prevented = false;

    contents.emit("will-navigate", { preventDefault: () => { prevented = true; } }, PICKER_OPEN_URL, undefined, true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(prevented).toBe(true);
    expect(harness.trace).toEqual([`picker:open:${PICKER_OPEN_URL}`]);
    expect(harness.trace).not.toContain(`load:${LOCAL}/console/`);
  });

  it("takes the cover back down when the list asks to be dismissed", async () => {
    const contents = new EventEmitter();
    const harness = createHarness();
    harness.bridge.attach(contents as never);
    harness.setCurrent(REMOTE);

    contents.emit("will-navigate", { preventDefault: () => undefined }, PICKER_DISMISS_URL, undefined, true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.trace).toEqual(["picker:close"]);
  });

  it("sends the chosen console to the main window and takes the cover down", async () => {
    const picker = new EventEmitter();
    const harness = createHarness();
    harness.bridge.attachPicker(picker as never);
    harness.setCurrent(REMOTE);

    picker.emit("will-navigate", { preventDefault: () => undefined }, `${REMOTE}/console/`, undefined, true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.trace).toContain(`load:${REMOTE}/console/`);
    expect(harness.trace.at(-1)).toBe("picker:close");
  });

  /** 실패한 채 덮개만 남으면 사용자는 멀쩡한 콘솔에 손이 닿지 않는다. */
  it("takes the cover down even when the chosen console refuses", async () => {
    const picker = new EventEmitter();
    const harness = createHarness({ responses: () => Response.json({ error: "remote_host_unknown" }, { status: 404 }) });
    harness.bridge.attachPicker(picker as never);

    picker.emit("will-navigate", { preventDefault: () => undefined }, `${REMOTE}/console/`, undefined, true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.trace).toContain("picker:close");
    expect(harness.notices[0]?.body).toContain("no longer in this list");
  });

  /** "호스트 관리"는 이름대로 관리 화면을 열어야 한다 — 집의 기본 화면에 내려놓으면 거짓말이다. */
  it("keeps the screen the list asked for when it sends the window home", async () => {
    const picker = new EventEmitter();
    const harness = createHarness();
    harness.bridge.attachPicker(picker as never);
    harness.setCurrent(REMOTE);

    picker.emit("will-navigate", { preventDefault: () => undefined }, `${LOCAL}/console/settings?section=remote-access`, undefined, true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.trace).toContain(`load:${LOCAL}/console/settings?section=remote-access`);
  });

  it("falls back to the default screen when the asked-for screen is not that console's", async () => {
    const picker = new EventEmitter();
    const harness = createHarness();
    harness.bridge.attachPicker(picker as never);

    await harness.bridge.open(LOCAL, `${REMOTE}/console/settings`);

    expect(harness.trace).toContain(`load:${LOCAL}/console/`);
  });

  it("does not summon a second list from inside the list", async () => {
    const picker = new EventEmitter();
    const harness = createHarness();
    harness.bridge.attachPicker(picker as never);

    picker.emit("will-navigate", { preventDefault: () => undefined }, PICKER_OPEN_URL, undefined, true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.trace).toEqual(["picker:close"]);
  });

  /**
   * 이 신호를 모르는 옛 셸에게 이 URL은 그냥 집의 콘솔이다 — 목록 대신 집에 착지하는,
   * 오늘과 똑같은 동선으로 강등된다. 그 판정이 유지되는지 여기서 못박는다.
   */
  it("still reads as the home console for a shell that never heard of the surface", () => {
    expect(consoleTarget(PICKER_OPEN_URL, LOCAL)).toBe(LOCAL);
  });
});
