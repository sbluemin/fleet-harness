import { runInNewContext } from "node:vm";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRemoteBridge } from "../src/remote-bridge.js";
import type { DesktopShellWindow } from "../src/shell-window.js";
import { createSwitchHold, SWITCH_FADE_MS, SWITCH_READY_CAP_MS, SWITCH_WARN_MIN_MS, type SwitchHold } from "../src/switch-hold.js";

const LOCAL = "http://127.0.0.1:4310";
const REMOTE = "https://100.84.12.7:6768";
const FINGERPRINT = "8D3FBB2A855053305C32280A2ABB566FFF9C5B14C353AE0527092ED476CBB70F";

/**
 * 붙잡아 둔 옛 화면만 남는 상태는 사용자를 창 밖으로 내쫓는다 — 아래의 콘솔은 살아 있는데 손이 닿지 않는다.
 * 그래서 이 파일은 판이 서는 길 하나와, 판이 반드시 걷히는 길들을 다리(remote-bridge)와 판(switch-hold)을
 * 실제로 이어 붙인 채 확인한다.
 */
function createHarness(options: { readonly load?: (url: string) => Promise<void>; readonly label?: string; readonly blankCapture?: boolean } = {}) {
  const scripts: string[] = [];
  const presented: unknown[] = [];
  const removed: unknown[] = [];
  const notices: string[] = [];
  const shell = {
    isDestroyed: () => false,
    base: { isVisible: () => true, isMinimized: () => false, on: () => undefined, off: () => undefined },
    stack: {
      layoutConsole: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
      parkHold: () => undefined,
      presentHold: (view: unknown) => { presented.push(view); },
      removeHold: (view: unknown) => { removed.push(view); },
    },
    consoleContents: {
      capturePage: async () => ({ isEmpty: () => options.blankCapture === true, toJPEG: () => Buffer.from("frame") }),
    },
  } as unknown as DesktopShellWindow;
  const hold: SwitchHold = createSwitchHold({
    shell: () => shell,
    createView: () => ({
      setBounds: () => undefined,
      webContents: { loadFile: async () => undefined, executeJavaScript: async (code: string) => { scripts.push(code); return true; }, close: () => undefined },
    }) as never,
    pagePath: "/switch.html",
    lang: "en",
    scheme: () => "dark",
    band: () => 36,
  });

  let current: string | null = LOCAL;
  let pending: string | null = null;
  const policy = {
    activateConsoleOrigin: (origin: string) => { current = origin; },
    currentConsoleOrigin: () => current,
    stageConsoleOrigin: (origin: string) => { pending = origin; },
    commitConsoleOrigin: () => { if (pending !== null) current = pending; pending = null; },
    cancelPendingConsoleOrigin: () => { pending = null; },
    admitRemoteConsoleOrigin: () => undefined,
    withdrawRemoteConsoleOrigin: () => undefined,
  };
  const navigation: { landed?: (event: unknown, url: string, code: number) => void } = {};
  const bridge = createRemoteBridge({
    pins: { pin: () => undefined, unpin: () => undefined, clear: () => undefined } as never,
    policy: () => policy as never,
    sessionFetch: async (url: string) => url.endsWith("/console/") ? new Response("<!doctype html>") : new Response(null, { status: 204 }),
    localFetch: (async () => Response.json({ origin: REMOTE, label: options.label ?? "build-mini", hostname: "100.84.12.7", port: 6768, fingerprint: FINGERPRINT, token: null })) as never,
    localOrigin: () => LOCAL,
    // main의 넘겨주기와 같은 차례 — 붙잡고, 적재하고, 다 받았다고 알린다.
    loadConsole: async (url) => {
      await hold.freeze();
      if (options.load) await options.load(url);
      hold.loaded(new URL(url).origin);
    },
    notify: (notice) => notices.push(notice.body),
    confirmIdentity: async () => undefined,
    hold,
  });
  bridge.attach({
    on: (event: string, listener: never) => { if (event === "did-navigate") navigation.landed = listener; },
    removeListener: () => undefined,
  } as never);
  return { bridge, hold, scripts, presented, removed, notices, navigation, current: () => current };
}

describe("switch hold", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("keeps the old screen until the new console says it drew, then lets go", async () => {
    // 이름은 사용자가 붙였거나 원격에서 온 것이다 — 치환 패턴이 섞여도 판에 들어가는 코드는 깨지지 않는다.
    const harness = createHarness({ label: "a$'b$&c$`d" });

    await harness.bridge.open(REMOTE);
    expect(harness.presented).toHaveLength(1);
    // 적재는 끝났지만 아직 첫 목록을 칠하지 않았다 — 판은 그대로다.
    await vi.advanceTimersByTimeAsync(SWITCH_READY_CAP_MS - 100);
    expect(harness.removed).toHaveLength(0);

    // 느린 전환의 알약은 그 이름을 글자 그대로 말한다.
    const pillText = { textContent: "" };
    const root = { setAttribute: () => undefined, classList: { add: () => undefined, remove: () => undefined }, style: { setProperty: () => undefined } };
    const pillScript = harness.scripts.find((script) => script.includes("\"tone\":\"busy\""));
    expect(pillScript).toBeDefined();
    expect(runInNewContext(pillScript ?? "", { document: { documentElement: root, getElementById: (id: string) => id === "pill-text" ? pillText : null } })).toBe(true);
    expect(pillText.textContent).toBe("Connecting to a$'b$&c$`d…");

    harness.hold.ready(REMOTE);
    await vi.advanceTimersByTimeAsync(SWITCH_FADE_MS + 50);
    expect(harness.removed).toHaveLength(1);
    expect(harness.current()).toBe(REMOTE);
  });

  it("always lets go: on a failed load, for a console that never says ready, and when the renderer dies", async () => {
    // 적재가 실패했다 — 경고를 읽을 만큼 보인 뒤 걷고, 실패는 여전히 알림으로 말한다.
    const failed = createHarness({ load: async () => { throw new Error("remote_link_unreachable"); } });
    await expect(failed.bridge.open(REMOTE)).rejects.toThrow("remote_link_unreachable");
    failed.bridge.report(new Error("remote_link_unreachable"));
    expect(failed.presented).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SWITCH_WARN_MIN_MS + SWITCH_FADE_MS + 100);
    expect(failed.removed).toHaveLength(1);
    expect(failed.notices).toHaveLength(1);

    // ready를 모르는 옛 콘솔 — 적재가 끝나고 상한이 지나면 걷는다.
    const silent = createHarness();
    await silent.bridge.open(REMOTE);
    await vi.advanceTimersByTimeAsync(SWITCH_READY_CAP_MS + SWITCH_FADE_MS + 100);
    expect(silent.removed).toHaveLength(1);

    // 붙잡지 못했다 — 판 없이, 예산을 기다리지도 않고 곧바로 항해한다.
    const blind = createHarness({ blankCapture: true });
    let navigated = false;
    void blind.bridge.open(REMOTE).then(() => { navigated = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(navigated).toBe(true);
    expect(blind.presented).toHaveLength(0);
    expect(blind.removed).toHaveLength(1);

    // 아래의 렌더러가 죽었다 — 기다리지 않는다.
    const gone = createHarness();
    await gone.bridge.open(REMOTE);
    gone.hold.release("render_gone");
    expect(gone.removed).toHaveLength(1);
  });

  /** 원격이 오류 문서에 착지하면 집으로 돌아간다. 쥔 화면을 놓지 않은 채 돌아가므로 두 번째 깜빡임이 없다. */
  it("holds the same screen through the way back home and lets go once home has drawn", async () => {
    const harness = createHarness();
    await harness.bridge.open(REMOTE);
    harness.navigation.landed?.({}, `${REMOTE}/console/`, 401);
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.current()).toBe(LOCAL);
    expect(harness.presented).toHaveLength(1);
    expect(harness.removed).toHaveLength(0);
    expect(harness.notices).toHaveLength(1);

    harness.hold.ready(LOCAL);
    await vi.advanceTimersByTimeAsync(SWITCH_WARN_MIN_MS + SWITCH_FADE_MS + 100);
    expect(harness.presented).toHaveLength(1);
    expect(harness.removed).toHaveLength(1);
  });
});
