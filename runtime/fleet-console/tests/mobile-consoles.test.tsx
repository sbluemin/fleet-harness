// @vitest-environment jsdom
import { act, createElement, createRef, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * 모바일 심리스 콘솔(계약 m2 1·2·4·6·7절, 개정 r1·r3) — 스토어 파서·메시지 모양, 홈 목록 렌더, 도착 1회, 구 셸 호환.
 * 홈 전체(MobileHome)는 피처 그래프가 커서, 홈이 사령관 목록 자리에 끼우는 MobileConsoleHomeList와
 * 셸이 부르는 도착 훅을 직접 그린다.
 */

const commodoreList = vi.hoisted(() => ({
  rows: [] as { commodoreId: string; theaters: { theaterId: string; status: string }[] }[],
  loaded: true,
  selected: [] as (string | null)[],
}));
vi.mock("../features/commodore/client/commodore-list.js", () => ({
  useCommodoreList: () => commodoreList.rows,
  commodoreListLoaded: () => commodoreList.loaded,
  selectMobileCommodore: (id: string | null) => { commodoreList.selected.push(id); },
}));
const consoleState = vi.hoisted(() => ({ bootstrapped: true, objectiveRecordsHydrated: true, objectiveRecords: [] as { id: string; commodoreId: string }[] }));
vi.mock("../core/client/src/hooks/use-store.js", () => ({ useConsoleState: () => consoleState }));
const focused = vi.hoisted(() => [] as string[]);
vi.mock("../core/client/src/integration/store.js", () => ({ focusObjective: (id: string) => { focused.push(id); } }));
const destinations = vi.hoisted(() => [] as unknown[]);
vi.mock("../core/client/src/chrome/mobile/mobile-store.js", () => ({
  setMobileDestination: (next: unknown) => { destinations.push(next); },
  setMobileListTheater: () => undefined,
  setMobileReturnDestination: () => undefined,
}));

const posted: Record<string, unknown>[] = [];
const appearanceBase = { v: 1, colorMode: "dark", systemScheme: "dark", fontScale: "default" };
const scope = window as unknown as Record<string, unknown>;
scope.__fleetMobileAppearance = { ...appearanceBase, consoles: { roster: true, seamless: true } };
scope.webkit = { messageHandlers: { fleetAppearance: { postMessage: (body: string) => { posted.push(JSON.parse(body) as Record<string, unknown>); } } } };

const store = await import("../core/client/src/integration/mobile-consoles-store.js");
const { MobileConsoleHomeList, useMobileConsoleArrival, useMobileFirstPaintSignal, useMobileHomeScrollRestore } = await import("../core/client/src/chrome/mobile/mobile-consoles.js");

const roster = (commodores: unknown[], extra: Record<string, unknown> = {}) => ({ v: 1, commodores, more: 0, ...extra });
const commodore = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, look: null, run: "quiet", ...extra });
const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id, label: `Console ${id}`, monogram: id.slice(0, 1).toUpperCase(), tone: "teal", active: false, status: "ok", at: 1, roster: roster([]), ...extra,
});
const activeEntry = (id: string) => entry(id, { active: true, status: null, at: null, roster: null });

function plant(state: unknown, capability = true): void {
  scope.__fleetMobileAppearance = capability ? { ...appearanceBase, consoles: { roster: true, seamless: true } } : { ...appearanceBase };
  scope.__fleetMobileConsoles = state;
}
function publish(state: unknown): void {
  scope.__fleetMobileConsoles = state;
  window.dispatchEvent(new CustomEvent("fleet-mobile-consoles", { detail: state }));
}

const mounted: (() => void)[] = [];
function mount(node: ReturnType<typeof createElement>): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => { root.render(node); });
  mounted.push(() => { act(() => root.unmount()); host.remove(); });
  return host;
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  posted.length = 0;
  focused.length = 0;
  destinations.length = 0;
  commodoreList.selected.length = 0;
  commodoreList.rows = [];
  commodoreList.loaded = true;
  consoleState.objectiveRecords = [];
  consoleState.objectiveRecordsHydrated = true;
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); }, removeItem: (key: string) => { saved.delete(key); }, clear: () => saved.clear() });
  store.resetMobileConsolesForTest();
});
afterEach(() => {
  for (const cleanup of mounted.splice(0)) cleanup();
  delete scope.__fleetMobileConsoles;
  delete scope.__fleetMobilePaintSignal;
  delete scope.__fleetMobilePainted;
  vi.unstubAllGlobals();
});

describe("mobile consoles parser", () => {
  it("keeps valid entries in shell order and drops malformed or duplicate ones", () => {
    const parsed = store.parseMobileConsolesState({
      v: 1,
      consoles: [activeEntry("a"), entry("b"), entry("bad id!"), entry("b"), { ...entry("c"), label: "" }, entry("d", { roster: { v: 2 } })],
      arrival: null,
    });
    expect(parsed?.consoles.map((item) => item.id)).toEqual(["a", "b", "d"]);
    expect(parsed?.consoles[2]?.roster).toBeNull();
  });

  it("needs exactly one active entry", () => {
    expect(store.parseMobileConsolesState({ v: 1, consoles: [entry("a"), entry("b")], arrival: null })).toBeNull();
    expect(store.parseMobileConsolesState({ v: 1, consoles: [activeEntry("a"), activeEntry("b")], arrival: null })).toBeNull();
    expect(store.parseMobileConsolesState({ v: 2, consoles: [activeEntry("a")], arrival: null })).toBeNull();
  });

  it("ignores the active roster, empties an unpaired roster and keeps a never-read entry as loading", () => {
    const parsed = store.parseMobileConsolesState({
      v: 1,
      consoles: [{ ...activeEntry("a"), roster: roster([commodore("x", "X")]) }, entry("b", { status: "unpaired", roster: roster([commodore("y", "Y")]) }), entry("c", { status: null, at: null, roster: null })],
      arrival: null,
    })!;
    expect(parsed.consoles[0]?.roster).toBeNull();
    expect(parsed.consoles[1]?.roster).toBeNull();
    expect(parsed.consoles[2]).toMatchObject({ status: null, roster: null, at: null, active: false });
  });

  it("parses arrival and clamps scrollTop", () => {
    const parsed = store.parseMobileConsolesState({ v: 1, consoles: [activeEntry("a")], arrival: { commodore: "c-1", commander: "o-1", scrollTop: 250_000.4 } });
    expect(parsed?.arrival).toEqual({ commodore: "c-1", commander: "o-1", scrollTop: 100_000 });
    expect(store.parseMobileConsolesState({ v: 1, consoles: [activeEntry("a")], arrival: { commodore: "bad\u0007" } })?.arrival).toBeNull();
  });

  it("reads the capability only when roster and seamless are both true", () => {
    expect(store.parseMobileConsolesCapability({ consoles: { roster: true, seamless: true } })).toBe(true);
    expect(store.parseMobileConsolesCapability({ consoles: { roster: true } })).toBe(false);
    expect(store.parseMobileConsolesCapability({})).toBe(false);
  });
});

describe("mobile consoles messages", () => {
  it("builds the switch shape with exact keys and omits absent optionals", () => {
    expect(store.mobileConsoleSwitchMessage({ console: "b", commodore: "c-1" })).toEqual({ v: 1, type: "switch", console: "b", commodore: "c-1" });
    expect(store.mobileConsoleSwitchMessage({ console: "b", commodore: "c-1", commander: null, scrollTop: null })).toEqual({ v: 1, type: "switch", console: "b", commodore: "c-1" });
    expect(store.mobileConsoleSwitchMessage({ console: "b", commodore: "c-1", commander: "o-1", scrollTop: 120.6 })).toEqual({ v: 1, type: "switch", console: "b", commodore: "c-1", commander: "o-1", scrollTop: 121 });
    expect(store.mobileConsoleSwitchMessage({ console: "b", commodore: "c-1", scrollTop: 900_000 })?.scrollTop).toBe(100_000);
    expect(store.mobileConsoleSwitchMessage({ console: "b/c", commodore: "c-1" })).toBeNull();
    expect(store.mobileConsoleSwitchMessage({ console: "b", commodore: "x".repeat(129) })).toBeNull();
    expect(store.mobileConsoleSwitchMessage({ console: "b", commodore: "c-1", commander: "a\nb" })).toBeNull();
    expect(store.mobileConsoleSwitchMessage({ console: "b", commodore: "c-1", scrollTop: Number.NaN })).toBeNull();
  });

  it("sends roster, switch only to a known inactive console", () => {
    plant({ v: 1, consoles: [activeEntry("a"), entry("b")], arrival: null });
    store.installMobileConsoles();
    expect(store.requestMobileConsoleRoster()).toBe(true);
    expect(store.switchMobileConsole({ console: "a", commodore: "c-1" })).toBe(false);
    expect(store.switchMobileConsole({ console: "zz", commodore: "c-1" })).toBe(false);
    expect(store.switchMobileConsole({ console: "b", commodore: "c-1", scrollTop: 40 })).toBe(true);
    expect(posted).toEqual([{ v: 1, type: "roster" }, { v: 1, type: "switch", console: "b", commodore: "c-1", scrollTop: 40 }]);
    expect(store.getMobileConsolesSnapshot().switching).toBe("b/c-1/");
  });

  it("sends nothing to an old shell without the capability key (new page, old shell)", () => {
    plant({ v: 1, consoles: [activeEntry("a"), entry("b")], arrival: { commodore: "c-1" } }, false);
    store.installMobileConsoles();
    expect(store.getMobileConsolesSnapshot()).toMatchObject({ capable: false, state: null });
    expect(store.requestMobileConsoleRoster()).toBe(false);
    expect(store.switchMobileConsole({ console: "b", commodore: "c-1" })).toBe(false);
    expect(store.takeMobileConsoleArrival()).toBeNull();
    expect(posted).toEqual([]);
  });

  it("applies the document-start arrival once and ignores later arrival values (r1)", () => {
    plant({ v: 1, consoles: [activeEntry("a"), entry("b")], arrival: { commodore: "c-1", scrollTop: 300 } });
    store.installMobileConsoles();
    expect(store.readMobileHomeScrollTop()).toBe(300);
    publish({ v: 1, consoles: [activeEntry("a"), entry("b")], arrival: null });
    expect(store.takeMobileConsoleArrival()).toEqual({ commodore: "c-1", commander: null, scrollTop: 300 });
    expect(store.takeMobileConsoleArrival()).toBeNull();
    publish({ v: 1, consoles: [activeEntry("a"), entry("b")], arrival: { commodore: "c-2" } });
    expect(store.takeMobileConsoleArrival()).toBeNull();
    expect(posted).toEqual([{ v: 1, type: "arrived" }]);
  });
});

describe("mobile home console sections", () => {
  const local = createElement("div", { className: "local-home" }, "local list");

  it("renders the current home unchanged without the capability", () => {
    plant({ v: 1, consoles: [activeEntry("a"), entry("b")], arrival: null }, false);
    store.installMobileConsoles();
    const host = mount(createElement(MobileConsoleHomeList, { local, scrollRef: createRef<HTMLElement>() }));
    expect(host.querySelector(".local-home")).not.toBeNull();
    expect(host.querySelector(".mobile-console-group")).toBeNull();
  });

  it("renders the current home unchanged with a single console", () => {
    plant({ v: 1, consoles: [activeEntry("a")], arrival: null });
    store.installMobileConsoles();
    const host = mount(createElement(MobileConsoleHomeList, { local, scrollRef: createRef<HTMLElement>() }));
    expect(host.querySelector(".local-home")).not.toBeNull();
    expect(host.querySelector(".mobile-console-head")).toBeNull();
  });

  it("draws one header section per console in shell order with the local list in the active slot", () => {
    plant({ v: 1, consoles: [entry("b", { roster: roster([commodore("c-1", "보리", { preview: "hello", commanders: [{ id: "o-1", title: "Fix", done: 1, total: 3, run: "working" }] })]) }), activeEntry("a")], arrival: null });
    store.installMobileConsoles();
    const host = mount(createElement(MobileConsoleHomeList, { local, scrollRef: createRef<HTMLElement>() }));
    const groups = [...host.querySelectorAll<HTMLElement>(".mobile-console-group")];
    expect(groups.map((group) => group.dataset.consoleId)).toEqual(["b", "a"]);
    expect(groups[1]?.querySelector(".local-home")).not.toBeNull();
    expect(groups[0]?.querySelector(".local-home")).toBeNull();
    expect(groups[0]?.querySelector("[data-roster-commodore='c-1']")?.textContent).toContain("hello");
    const chip = groups[0]!.querySelector<HTMLButtonElement>("[data-roster-commander='o-1']")!;
    expect(chip.textContent).toContain("1/3");
    act(() => { chip.click(); });
    expect(posted.at(-1)).toEqual({ v: 1, type: "switch", console: "b", commodore: "c-1", commander: "o-1", scrollTop: 0 });
    expect(chip.getAttribute("aria-busy")).toBe("true");
    // 목록은 그대로 — 행이 사라지지 않는다.
    expect(host.querySelectorAll(".mobile-console-group")).toHaveLength(2);
  });

  it("shows unavailable, unpaired, unsupported and loading states", () => {
    plant({
      v: 1,
      consoles: [
        activeEntry("a"),
        entry("b", { status: "unavailable", roster: roster([commodore("c-1", "Kept")]) }),
        entry("c", { status: "unpaired", roster: null }),
        entry("d", { status: "unsupported", roster: null }),
        entry("e", { status: null, at: null, roster: null }),
      ],
      arrival: null,
    });
    store.installMobileConsoles();
    const host = mount(createElement(MobileConsoleHomeList, { local, scrollRef: createRef<HTMLElement>() }));
    const group = (id: string) => host.querySelector<HTMLElement>(`.mobile-console-group[data-console-id='${id}']`)!;
    expect(group("b").classList.contains("is-dim")).toBe(true);
    expect(group("b").querySelector(".mobile-console-status")?.textContent).toBe("Not connected");
    expect(group("b").querySelector("[data-roster-commodore='c-1']")).not.toBeNull();
    expect(group("c").querySelector(".mobile-console-status")?.textContent).toBe("Needs reconnecting");
    expect(group("d").querySelector(".mobile-console-status")?.textContent).toBe("Can't show this console's commodores");
    // r5 — 목록을 볼 수 없는 콘솔의 머리글은 접지 않고 네이티브 콘솔 시트를 연다(switch 아님).
    const before = posted.length;
    act(() => { group("d").querySelector<HTMLButtonElement>(".mobile-console-toggle")!.click(); });
    expect(posted.slice(before)).toEqual([{ v: 1, type: "consoles" }]);
    expect(group("d").querySelector(".mobile-console-toggle")?.hasAttribute("aria-expanded")).toBe(false);
    expect(group("e").querySelector(".mobile-console-note")?.textContent).toBe("Loading list…");
    expect(group("a").querySelector(".mobile-console-status")?.textContent).toBe("This Console");
    // 다시 연결은 네이티브 콘솔 시트를 연다(전환 메시지가 아니다).
    act(() => { group("c").querySelector<HTMLButtonElement>(".mobile-console-action")!.click(); });
    expect(posted.at(-1)).toEqual({ v: 1, type: "consoles" });
  });

  it("folds a console header and remembers it on this device", () => {
    plant({ v: 1, consoles: [activeEntry("a"), entry("b", { roster: roster([commodore("c-1", "X")]) })], arrival: null });
    store.installMobileConsoles();
    const host = mount(createElement(MobileConsoleHomeList, { local, scrollRef: createRef<HTMLElement>() }));
    act(() => { host.querySelector<HTMLButtonElement>(".mobile-console-group[data-console-id='b'] .mobile-console-toggle")!.click(); });
    expect(host.querySelector("[data-roster-commodore='c-1']")).toBeNull();
    expect(JSON.parse(localStorage.getItem("fleet-console.mobile-console-folded") ?? "[]")).toEqual(["b"]);
  });
});

describe("mobile console arrival", () => {
  function Probe() {
    useMobileConsoleArrival();
    return null;
  }

  it("opens the arrived commander once and sends arrived", () => {
    commodoreList.rows = [{ commodoreId: "c-1", theaters: [] }];
    consoleState.objectiveRecords = [{ id: "o-1", commodoreId: "c-1" }];
    plant({ v: 1, consoles: [activeEntry("a"), entry("b")], arrival: { commodore: "c-1", commander: "o-1", scrollTop: 10 } });
    store.installMobileConsoles();
    mount(createElement(Probe));
    mount(createElement(Probe));
    expect(commodoreList.selected).toEqual(["c-1"]);
    expect(focused).toEqual(["o-1"]);
    expect(posted.filter((body) => body.type === "arrived")).toHaveLength(1);
  });

  it("waits for objective hydration before consuming a commander arrival", () => {
    commodoreList.rows = [{ commodoreId: "c-1", theaters: [] }];
    consoleState.objectiveRecordsHydrated = false;
    plant({ v: 1, consoles: [activeEntry("a"), entry("b")], arrival: { commodore: "c-1", commander: "o-1" } });
    store.installMobileConsoles();
    mount(createElement(Probe));
    expect(destinations).toEqual([]);
    expect(posted).toEqual([]);
    consoleState.objectiveRecords = [{ id: "o-1", commodoreId: "c-1" }];
    consoleState.objectiveRecordsHydrated = true;
    mount(createElement(Probe));
    expect(focused).toEqual(["o-1"]);
    expect(posted).toEqual([{ v: 1, type: "arrived" }]);
  });

  it("waits for the commodore list, then opens the commodore", () => {
    commodoreList.loaded = false;
    commodoreList.rows = [{ commodoreId: "c-1", theaters: [] }];
    plant({ v: 1, consoles: [activeEntry("a"), entry("b")], arrival: { commodore: "c-1" } });
    store.installMobileConsoles();
    mount(createElement(Probe));
    expect(destinations).toEqual([]);
    commodoreList.loaded = true;
    mount(createElement(Probe));
    expect(destinations).toEqual([{ kind: "plugin", entryId: "commodore", params: { commodoreId: "c-1" } }]);
    expect(focused).toEqual([]);
  });

  it("stays home for an unknown commodore and still sends arrived", () => {
    commodoreList.rows = [{ commodoreId: "c-1", theaters: [] }];
    plant({ v: 1, consoles: [activeEntry("a"), entry("b")], arrival: { commodore: "gone" } });
    store.installMobileConsoles();
    mount(createElement(Probe));
    expect(destinations).toEqual([]);
    expect(commodoreList.selected).toEqual([]);
    expect(posted).toEqual([{ v: 1, type: "arrived" }]);
  });
});

describe("mission 7 fixes", () => {
  it("clears the opening marker when the shell reports that console failed, even with no status change (r6)", () => {
    const state = { v: 1, consoles: [activeEntry("a"), entry("b", { status: "unavailable" }), entry("c")], arrival: null };
    plant(state);
    store.installMobileConsoles();
    // 이미 unavailable인 콘솔로의 전환 — 상태 변화가 없으니 실패 알림 전까지는 표시가 남는다.
    expect(store.switchMobileConsole({ console: "b", commodore: "c-1" })).toBe(true);
    expect(store.getMobileConsolesSnapshot().switching).toBe("b/c-1/");
    window.dispatchEvent(new CustomEvent("fleet-mobile-consoles", { detail: { ...state, failed: "b" } }));
    expect(store.getMobileConsolesSnapshot().switching).toBeNull();
  });

  it("keeps the opening marker when another console fails (r6)", () => {
    const state = { v: 1, consoles: [activeEntry("a"), entry("b"), entry("c")], arrival: null };
    plant(state);
    store.installMobileConsoles();
    expect(store.switchMobileConsole({ console: "b", commodore: "c-1", commander: "o-1" })).toBe(true);
    window.dispatchEvent(new CustomEvent("fleet-mobile-consoles", { detail: { ...state, failed: "c" } }));
    publish(state);
    expect(store.getMobileConsolesSnapshot().switching).toBe("b/c-1/o-1");
    expect(store.failedConsoleOf(new CustomEvent("x", { detail: { failed: "bad id!" } }))).toBeNull();
    expect(store.failedConsoleOf(new Event("x"))).toBeNull();
  });

  function ScrollProbe() {
    const ref = useRef<HTMLDivElement>(null);
    useMobileHomeScrollRestore(ref);
    return createElement("div", { ref, className: "probe-scroll" });
  }

  const scrollOf = (host: HTMLElement) => host.querySelector<HTMLElement>(".probe-scroll")!.scrollTop;
  const unmountAll = () => { mounted.splice(0).forEach((cleanup) => cleanup()); };

  it("restores the arrival scroll once on the first return home after a switch, then behaves as before (D1, 936bd6b1)", () => {
    commodoreList.rows = [{ commodoreId: "c-1", theaters: [] }];
    plant({ v: 1, consoles: [activeEntry("a"), entry("b")], arrival: { commodore: "c-1", scrollTop: 300 } });
    store.installMobileConsoles();
    // 도착을 처리하기 전에 서 있던 홈은 복원을 쓰지 않는다.
    const early = mount(createElement(ScrollProbe));
    mount(createElement(PaintProbe, { kind: "home" }));
    expect(scrollOf(early)).toBe(0);
    expect(store.readMobileHomeScrollTop()).toBe(300);
    unmountAll();
    // 도착이 연 사령관 화면이 서고, 뒤로 가서 홈이 다시 서면 누를 때의 위치다.
    mount(createElement(PaintProbe, { kind: "commodore" }));
    const back = mount(createElement(ScrollProbe));
    expect(scrollOf(back)).toBe(300);
    expect(store.readMobileHomeScrollTop()).toBeNull();
    // 그 뒤 같은 콘솔 안에서 사령관을 열었다 돌아오면 현행처럼 복원하지 않는다(스크롤도 기억하지 않는다).
    const element = back.querySelector<HTMLElement>(".probe-scroll")!;
    element.scrollTop = 120;
    element.dispatchEvent(new Event("scroll"));
    unmountAll();
    const again = mount(createElement(ScrollProbe));
    expect(scrollOf(again)).toBe(0);
    expect(store.readMobileHomeScrollTop()).toBeNull();
  });

  it("restores at once when the arrival stays home (unknown commodore)", () => {
    commodoreList.rows = [{ commodoreId: "c-1", theaters: [] }];
    plant({ v: 1, consoles: [activeEntry("a"), entry("b")], arrival: { commodore: "gone", scrollTop: 240 } });
    store.installMobileConsoles();
    mount(createElement(PaintProbe, { kind: "home" }));
    const home = mount(createElement(ScrollProbe));
    expect(scrollOf(home)).toBe(240);
    unmountAll();
    expect(scrollOf(mount(createElement(ScrollProbe)))).toBe(0);
  });

  it("does not restore in a document without an arrival", () => {
    plant({ v: 1, consoles: [activeEntry("a"), entry("b")], arrival: null });
    store.installMobileConsoles();
    expect(store.readMobileHomeScrollTop()).toBeNull();
    const home = mount(createElement(ScrollProbe));
    const element = home.querySelector<HTMLElement>(".probe-scroll")!;
    element.scrollTop = 90;
    element.dispatchEvent(new Event("scroll"));
    unmountAll();
    expect(scrollOf(mount(createElement(ScrollProbe)))).toBe(0);
    expect(store.readMobileHomeScrollTop()).toBeNull();
  });

  function PaintProbe({ kind }: { readonly kind: "objective" | "commodore" | "home" | "other" }) {
    useMobileConsoleArrival();
    useMobileFirstPaintSignal({ ready: true, kind });
    return null;
  }

  it("raises the paint signal at boot and fires painted once after the arrival screen (r7)", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    commodoreList.rows = [{ commodoreId: "c-1", theaters: [] }];
    plant({ v: 1, consoles: [activeEntry("a"), entry("b")], arrival: { commodore: "c-1" } });
    store.installMobileConsoles();
    expect(scope.__fleetMobilePaintSignal).toBe(true);
    let painted = 0;
    const onPainted = () => { painted += 1; };
    window.addEventListener("fleet-mobile-painted", onPainted);
    try {
      // 도착이 사령관을 열었으니 홈이 먼저 그려져도 알리지 않는다.
      mount(createElement(PaintProbe, { kind: "home" }));
      expect(painted).toBe(0);
      mount(createElement(PaintProbe, { kind: "commodore" }));
      mount(createElement(PaintProbe, { kind: "commodore" }));
      expect(painted).toBe(1);
      expect(scope.__fleetMobilePainted).toBe(true);
    } finally {
      window.removeEventListener("fleet-mobile-painted", onPainted);
    }
  });

  it("falls back to a 100ms timer when animation frames are paused, firing only once (r7)", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let frame: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    plant({ v: 1, consoles: [activeEntry("a")], arrival: null });
    store.installMobileConsoles();
    let painted = 0;
    const onPainted = () => { painted += 1; };
    window.addEventListener("fleet-mobile-painted", onPainted);
    try {
      store.markMobileFirstPaint();
      vi.advanceTimersByTime(99);
      expect(painted).toBe(0);
      vi.advanceTimersByTime(1);
      expect(painted).toBe(1);
      expect(scope.__fleetMobilePainted).toBe(true);
      // 늦게 돈 프레임은 다시 보내지 않는다.
      (frame as FrameRequestCallback | null)?.(0);
      store.markMobileFirstPaint();
      vi.runAllTimers();
      expect(painted).toBe(1);
    } finally {
      window.removeEventListener("fleet-mobile-painted", onPainted);
      vi.useRealTimers();
    }
  });

  it("fires painted after the home list when there is no arrival (r7)", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    plant({ v: 1, consoles: [activeEntry("a")], arrival: null });
    store.installMobileConsoles();
    let painted = 0;
    const onPainted = () => { painted += 1; };
    window.addEventListener("fleet-mobile-painted", onPainted);
    try {
      mount(createElement(PaintProbe, { kind: "home" }));
      expect(painted).toBe(1);
    } finally {
      window.removeEventListener("fleet-mobile-painted", onPainted);
    }
  });
});
