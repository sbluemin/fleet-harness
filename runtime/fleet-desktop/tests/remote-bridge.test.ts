import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { SurfaceSelection, SwitchAttempt } from "../src/console-surface-state.js";
import { createRemoteBridge } from "../src/remote-bridge.js";

const LOCAL = "http://127.0.0.1:4310";
const REMOTE = "https://100.84.12.7:6768";
const FINGERPRINT = "8D3FBB2A855053305C32280A2ABB566FFF9C5B14C353AE0527092ED476CBB70F";
const OLD_FINGERPRINT = "11".repeat(32);

function handoff(overrides: Record<string, unknown> = {}): Response {
  return Response.json({ id: "host-1", origin: REMOTE, hostname: "100.84.12.7", port: 6768, fingerprint: FINGERPRINT, pinGeneration: 2, cookieBoundFingerprint: FINGERPRINT, token: "grant-token", ...overrides });
}

function attempt(isCurrent: () => boolean = () => true): SwitchAttempt {
  return { generation: 1, isCurrent };
}

/** 무엇이 어떤 차례로 일어났는지가 이 다리의 계약이라, 호출을 한 줄로 기록해 둔다. */
function createHarness(options: {
  readonly responses?: (path: string) => Response;
  readonly confirm?: () => Promise<void>;
  readonly load?: (url: string) => Promise<void>;
  readonly verify?: () => Response;
  readonly trustedOtherIdentity?: boolean;
  readonly localSelection?: boolean;
  readonly currentPicker?: unknown;
} = {}) {
  const trace: string[] = [];
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const selections: SurfaceSelection[] = [];
  let data: string | null = null;
  let pending: string | null = null;
  const policy = {
    dataConsoleOrigin: () => data,
    // 실제 정책과 같은 의미론으로 둔다 — 확정 전까지 데이터 뷰의 origin은 옛 값 그대로다.
    stageDataOrigin: (origin: string) => { trace.push(`stage:${origin}`); pending = origin; },
    commitDataOrigin: () => { trace.push("commit"); if (pending !== null) data = pending; pending = null; },
    cancelPendingDataOrigin: () => { trace.push("cancel"); pending = null; },
    admitRemoteConsoleOrigin: (origin: string) => trace.push(`admit:${origin}`),
    withdrawRemoteConsoleOrigin: (origin: string) => trace.push(`withdraw:${origin}`),
  };
  const pins = {
    pin: (hostname: string) => trace.push(`pin:${hostname}`),
    unpin: (hostname: string) => trace.push(`unpin:${hostname}`),
    clear: () => trace.push("clear"),
    trustedOtherIdentity: () => options.trustedOtherIdentity ?? false,
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
    policy: () => policy as never,
    sessionFetch,
    remoteFetch: (async (url: string) => { trace.push(`remote:${url}`); return new Response(null, { status: 204 }); }) as never,
    localFetch: (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      const path = new URL(url).pathname;
      trace.push(`ask:${path}`);
      return options.responses ? options.responses(path) : handoff();
    }) as never,
    localOrigin: () => LOCAL,
    purgeCookies: async (origin, names) => { trace.push(`purge:${origin}:${names.join(",")}`); },
    loadData: async (url) => {
      trace.push(`load:${url}`);
      if (options.load) await options.load(url);
    },
    select: async (selection) => { selections.push(selection); },
    acceptsLocalSelection: () => options.localSelection ?? true,
    isCurrentPicker: (contents) => contents === options.currentPicker,
    disconnect: (reason) => trace.push(`disconnect:${reason}`),
    openPicker: async (url: string) => { trace.push(`picker:open:${url}`); },
    closePicker: () => trace.push("picker:close"),
    notify: () => undefined,
    confirmIdentity: options.confirm ?? (async () => { trace.push("confirm"); }),
  });

  return { bridge, trace, requests, selections, sessionFetch, dataOrigin: () => data };
}

function navigation(contents: EventEmitter, url: string, currentUrl = `${LOCAL}/console/`): boolean {
  let prevented = false;
  (contents as EventEmitter & { getURL: () => string }).getURL = () => currentUrl;
  contents.emit("will-navigate", { preventDefault: () => { prevented = true; } }, url, undefined, true);
  return prevented;
}

describe("remote bridge", () => {
  it("confirms the certificate before Chromium is ever pointed at that host", async () => {
    const harness = createHarness();

    await harness.bridge.prepare({ origin: REMOTE }, attempt());

    // 대조가 핀·허용·적재보다 먼저다 — 어긋난 판정이 한 번 캐시에 들어가면 재시작 전까지 살아남는다.
    expect(harness.trace).toEqual([
      "ask:/api/v1/desktop/handoff",
      "confirm",
      "pin:100.84.12.7",
      `admit:${REMOTE}`,
      `join:${REMOTE}/api/v1/join`,
      "ask:/api/v1/remote-hosts/host-1/cookie-binding",
      // 창을 보내기 전에 콘솔이 정말 콘솔을 내주는지 확인한다 — loadURL은 401 본문도 성공으로 되돌린다.
      `verify:${REMOTE}/console/`,
      `stage:${REMOTE}`,
      `load:${REMOTE}/console/`,
      "commit",
    ]);
  });

  /**
   * 링크의 1회용 자격은 처음 한 번만 실려 온다. 그 뒤로 token이 비어 와도 조인을 건너뛰지
   * 않는다 — 그 요청이 창의 페어링 쿠키를 세션으로 바꾸는 유일한 자리이고, 제어권을
   * 회수당했거나 접속이 만료된 뒤 돌아오는 길이 바로 그것이다.
   */
  it("still joins when the grant was already spent, so a paired device can resume", async () => {
    const harness = createHarness({ responses: () => handoff({ token: null }) });

    await harness.bridge.prepare({ origin: REMOTE }, attempt());

    expect(harness.trace.filter((entry) => entry.startsWith("join:"))).toEqual([`join:${REMOTE}/api/v1/join`]);
    expect(harness.trace).toContain(`load:${REMOTE}/console/`);
  });

  it("leaves no trust behind when the certificate does not match", async () => {
    const harness = createHarness({ confirm: async () => { throw new Error("remote_link_fingerprint_mismatch"); } });

    await expect(harness.bridge.prepare({ origin: REMOTE }, attempt())).rejects.toThrow("remote_link_fingerprint_mismatch");

    expect(harness.trace).toEqual(["ask:/api/v1/desktop/handoff"]);
  });

  it("rolls the pin and the admitted origin back when the console fails to load", async () => {
    const harness = createHarness({ load: async () => { throw new Error("ERR_CONNECTION_REFUSED"); } });

    await expect(harness.bridge.prepare({ origin: REMOTE }, attempt())).rejects.toThrow("ERR_CONNECTION_REFUSED");

    expect(harness.trace).toContain("cancel");
    expect(harness.trace).toContain(`withdraw:${REMOTE}`);
    expect(harness.trace).not.toContain("commit");
    // 조인이 만든 세션은 보여 주지 못했어도 끝낸다 — 상대 화면에 커튼이 남지 않게. 핀은 그 요청이 닿은 뒤에 푼다.
    await vi.waitFor(() => expect(harness.trace).toContain("unpin:100.84.12.7"));
    expect(harness.trace.indexOf(`remote:${REMOTE}/api/v1/access/self/leave`)).toBeGreaterThan(-1);
    expect(harness.trace.indexOf(`remote:${REMOTE}/api/v1/access/self/leave`)).toBeLessThan(harness.trace.indexOf("unpin:100.84.12.7"));
  });

  it("never loads a console that answers with an error document, and never joins again for it", async () => {
    const harness = createHarness({ verify: () => Response.json({ error: "unauthorized" }, { status: 401 }) });

    await expect(harness.bridge.prepare({ origin: REMOTE }, attempt())).rejects.toThrow("remote_host_session_expired");

    // 뷰는 움직이지 않았고, 신뢰도 남지 않았고, 두 번째 조인도 없다 — 재개는 사람의 새 선택으로만 한다.
    expect(harness.trace).not.toContain(`load:${REMOTE}/console/`);
    expect(harness.trace.filter((entry) => entry.startsWith("join:"))).toHaveLength(1);
    expect(harness.trace).toContain(`withdraw:${REMOTE}`);
  });

  /**
   * 인증서가 바뀐 호스트에 옛 페어링 비밀이 가면, 새 인증서를 쥔 쪽이 그 비밀을 받는다. 쿠키가 지금 신원에
   * 묶였다는 기록이 없으면 정확히 그 콘솔의 두 쿠키를 지운 뒤에만 자격을 보낸다 — 새 링크가 없으면 거기서 멈춘다.
   */
  it("removes the old credentials before a changed certificate hears from this device", async () => {
    const withoutLink = createHarness({ responses: () => handoff({ cookieBoundFingerprint: OLD_FINGERPRINT, token: null }) });
    await expect(withoutLink.bridge.prepare({ origin: REMOTE }, attempt())).rejects.toThrow("remote_host_link_required");
    expect(withoutLink.trace).toEqual([
      "ask:/api/v1/desktop/handoff",
      "confirm",
      `purge:${REMOTE}:fleet_console_session_6768,fleet_console_pairing_6768`,
    ]);

    const withLink = createHarness({ responses: (path) => (path.endsWith("/cookie-binding") ? new Response(null, { status: 204 }) : handoff({ cookieBoundFingerprint: null })) });
    await withLink.bridge.prepare({ origin: REMOTE }, attempt());
    const purged = withLink.trace.indexOf(`purge:${REMOTE}:fleet_console_session_6768,fleet_console_pairing_6768`);
    expect(purged).toBeGreaterThan(-1);
    expect(purged).toBeLessThan(withLink.trace.indexOf(`join:${REMOTE}/api/v1/join`));
    expect(JSON.parse(String(withLink.requests.find((request) => request.url.endsWith("/cookie-binding"))?.init.body))).toEqual({ fingerprint: FINGERPRINT, pinGeneration: 2 });

    // 이 실행이 이 호스트명의 다른 인증서를 이미 믿었다면, Chromium의 판정 캐시 때문에 새 핀을 믿을 수 없다.
    const cached = createHarness({ trustedOtherIdentity: true });
    await expect(cached.bridge.prepare({ origin: REMOTE }, attempt())).rejects.toThrow("remote_host_restart_required");
    expect(cached.trace.some((entry) => entry.startsWith("join:") || entry.startsWith("pin:"))).toBe(false);
  });

  it("hands a link over without reading it, then selects what the console resolved", async () => {
    const link = "fleet://join?code=eyJ2IjoxfQ";
    const harness = createHarness({
      responses: (path) => (path === "/api/v1/remote-hosts" ? Response.json({ host: { origin: REMOTE } }, { status: 201 }) : handoff()),
    });

    await harness.bridge.receiveLink(link);

    expect(harness.requests[0]?.url).toBe(`${LOCAL}/api/v1/remote-hosts`);
    expect(harness.requests[0]?.init.body).toBe(JSON.stringify({ link }));
    expect(harness.selections).toEqual([{ origin: REMOTE }]);
  });

  /**
   * 데이터 뷰의 origin 자리는 하나뿐이다. 앞선 시도가 늦게 끝나면서 뒤에 온 시도의 예약을 확정하면,
   * 정책은 뷰가 가 있지도 않은 콘솔을 가리킨 채 남는다.
   */
  it("does not let a superseded attempt commit the origin a newer one staged", async () => {
    const FIRST = "http://127.0.0.1:50001";
    const SECOND = "http://127.0.0.1:50002";
    const gates = new Map<string, () => void>();
    const harness = createHarness({
      responses: () => Response.json({
        consoles: [
          { origin: FIRST, version: "1.52.0", owner: "cli", distro: null },
          { origin: SECOND, version: "1.52.0", owner: "cli", distro: null },
        ],
      }),
      load: (url) => new Promise<void>((resolve) => { gates.set(url, resolve); }),
    });
    let latest = 1;

    const first = harness.bridge.prepare({ origin: FIRST }, attempt(() => latest === 1));
    await vi.waitFor(() => expect(gates.has(`${FIRST}/console/`)).toBe(true));
    latest = 2;
    const second = harness.bridge.prepare({ origin: SECOND }, attempt(() => latest === 2));
    await vi.waitFor(() => expect(gates.has(`${SECOND}/console/`)).toBe(true));

    // 먼저 시작한 쪽이 늦게 끝난다.
    gates.get(`${FIRST}/console/`)!();
    await expect(first).rejects.toThrow("surface_switch_superseded");
    gates.get(`${SECOND}/console/`)!();
    await second;

    expect(harness.trace.filter((entry) => entry === "commit")).toHaveLength(1);
    expect(harness.dataOrigin()).toBe(SECOND);
  });
});

const PICKER_OPEN_URL = `${LOCAL}/console/?desktop-surface=host-picker&at=${encodeURIComponent(REMOTE)}`;

/** 선택은 이 앱이 띄운 콘솔이 그린 화면에서만 온다. 남의 콘솔이 서빙한 화면은 목록을 열어 달라고 청할 수만 있다. */
describe("trusted console selection", () => {
  it("lets a data view open the home list but never choose a console", async () => {
    const contents = new EventEmitter();
    const harness = createHarness();
    harness.bridge.attachData(contents as never);

    expect(navigation(contents, PICKER_OPEN_URL, `${REMOTE}/console/`)).toBe(true);
    // 스크립트가 신뢰 UI를 연달아 띄우지 못하게 간격을 둔다.
    expect(navigation(contents, PICKER_OPEN_URL, `${REMOTE}/console/`)).toBe(true);
    expect(navigation(contents, `${LOCAL}/console/`, `${REMOTE}/console/`)).toBe(true);
    expect(navigation(contents, "https://10.0.0.9:6768/console/", `${REMOTE}/console/`)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.trace.filter((entry) => entry.startsWith("picker:open:"))).toEqual([`picker:open:${PICKER_OPEN_URL}`]);
    expect(harness.selections).toEqual([]);
  });

  it("carries only the Zen mode into a remote console, not the requesting page's path or query", async () => {
    const harness = createHarness();

    await harness.bridge.prepare({ origin: REMOTE, url: `${REMOTE}/console/settings?fleet-zen=1&section=remote-access` }, attempt());

    expect(harness.trace).toContain(`load:${REMOTE}/console/?fleet-zen=1`);
  });

  it("takes a choice only from the host picker that is open now", async () => {
    const current = new EventEmitter();
    const stale = new EventEmitter();
    const harness = createHarness({ currentPicker: current });
    harness.bridge.attachPicker(current as never);
    harness.bridge.attachPicker(stale as never);

    expect(navigation(stale, `${REMOTE}/console/`)).toBe(true);
    // 지금 떠 있는 덮개라도 집 origin이 아닌 문서에서 온 항해는 선택이 아니다.
    expect(navigation(current, `${REMOTE}/console/`, `${REMOTE}/console/`)).toBe(true);
    expect(harness.selections).toEqual([]);

    expect(navigation(current, `${REMOTE}/console/`)).toBe(true);
    expect(harness.selections).toEqual([{ origin: REMOTE, url: `${REMOTE}/console/` }]);
  });

});
