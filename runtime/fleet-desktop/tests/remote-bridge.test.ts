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
});

const PICKER_OPEN_URL = `${LOCAL}/console/?desktop-surface=host-picker&at=${encodeURIComponent(REMOTE)}`;
const PICKER_DISMISS_URL = `${LOCAL}/console/?desktop-surface=host-picker-dismiss`;

/** 항해 하나가 두 뜻으로 읽히면 안 된다 — 목록을 펴는 신호와, 창째로 집에 가는 길. */
describe("host picker surface", () => {

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
});
