// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://192.168.0.62:63371/console/" }

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostSwitcher, readHostPickerSurface } from "../core/client/src/components/command-band-system-cluster.js";
import { HostPickerScreen } from "../core/client/src/components/host-picker-surface.js";
import { __resetPaneStoreForTests, getPaneStoreSnapshot } from "../core/client/src/pane/pane-store.js";
import { closeRailPanel, getRailStoreSnapshot, setRailChromeExpanded } from "../core/client/src/rail/rail-store.js";

const HOME = "http://127.0.0.1:59229";
/** 같은 기계에서 따로 돌고 있는, 스캔이 정규 슬롯에서 찾아낸 콘솔. */
const NEIGHBOUR = "http://127.0.0.1:50000";
const HERE = "https://192.168.0.62:63371";
const THERE = "https://10.211.55.3:6186";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let assign: ReturnType<typeof vi.fn>;
let requested: string[];

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 원격 콘솔이 서빙한 화면. 목록 두 경로는 여기서 401이지만, 이 테스트가 지키는 것은 그 답이
 * 아니라 "요청이 아예 남지 않는다"는 쪽이다.
 */
function stubRemoteConsole(): void {
  requested = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const path = new URL(input, HERE).pathname;
    requested.push(path);
    if (path === "/api/v1/desktop/shell") return Response.json({ homeOrigin: HOME });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }));
}

const scanned = (origin: string) => ({ origin, version: "1.51.0", owner: "desktop", distro: null });

/** 이 기계의 어느 콘솔이 자기 루프백에서 목록을 내주는 화면. 셸이 말하는 집은 언제나 HOME이다. */
function stubLoopbackConsole(origin: string, consoles: readonly ReturnType<typeof scanned>[]): void {
  standOn(origin);
  requested = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const path = new URL(input, origin).pathname;
    requested.push(path);
    if (path === "/api/v1/desktop/shell") return Response.json({ homeOrigin: HOME });
    if (path === "/api/v1/local-consoles") {
      return Response.json({ consoles });
    }
    if (path === "/api/v1/remote-hosts") {
      return Response.json({
        hosts: [
          { id: "there", label: "SBLUEMIN2C23", origin: THERE, hostname: "10.211.55.3", port: 6186, fingerprint: "A".repeat(64), addedAt: 1, lastOpenedAt: null },
          { id: "here", label: "dotobokuliui-Macmini", origin: HERE, hostname: "192.168.0.62", port: 63371, fingerprint: "B".repeat(64), addedAt: 2, lastOpenedAt: null },
        ],
      });
    }
    return Response.json({ reachable: true, trusted: true });
  }));
}

/** 집이 자기 루프백에서 목록을 내주는 화면. */
function stubHomeConsole(consoles: readonly ReturnType<typeof scanned>[] = [scanned(HOME)]): void {
  stubLoopbackConsole(HOME, consoles);
}

/** jsdom의 location은 재정의를 거부하므로 전역을 통째로 세워 둔다. */
function standOn(origin: string): void {
  assign = vi.fn();
  vi.stubGlobal("location", { origin, host: new URL(origin).host, search: "", href: `${origin}/console/`, assign });
}

beforeEach(() => {
  document.body.replaceChildren();
  document.documentElement.dataset.desktopShell = "true";
  standOn(HERE);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  delete document.documentElement.dataset.desktopShell;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(element: ReturnType<typeof createElement>): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(createElement(MemoryRouter, null, element)); });
  // 셸 origin·목록 응답이 상태에 반영될 때까지 한 턴 더 돌린다.
  await act(async () => { await Promise.resolve(); });
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
}

function rowText(): string[] {
  return rows().map((row) => row.textContent ?? "");
}

describe("host picker surface query", () => {
  it.each([
    ["?desktop-surface=host-picker", null],
    [`?desktop-surface=host-picker&at=${encodeURIComponent(HERE)}`, HERE],
    // 부른 쪽이 실어 보낸 값이라 모양을 먼저 본다 — 화면에 그릴 값이기 때문이다.
    ["?desktop-surface=host-picker&at=not-an-origin", null],
    [`?desktop-surface=host-picker&at=${encodeURIComponent(`${HERE}/console/`)}`, null],
  ])("reads %s", (search, at) => {
    expect(readHostPickerSurface(search)).toEqual({ at });
  });

  it.each([
    ["a plain console url", ""],
    ["the dismissal signal", "?desktop-surface=host-picker-dismiss"],
    ["an unknown surface", "?desktop-surface=whatever"],
  ])("refuses %s", (_label, search) => {
    expect(readHostPickerSurface(search)).toBeNull();
  });
});

describe("host box on a remote console", () => {
  /**
   * 이 제안의 결정 축. 목록이 B를 지나가지 않는다는 것은 B가 401을 돌려준다는 뜻이 아니라,
   * B에게 물은 적이 없다는 뜻이다.
   */
  it("never asks the console it is standing on for a roster", async () => {
    stubRemoteConsole();

    await mount(createElement(HostSwitcher));

    expect(requested).not.toContain("/api/v1/remote-hosts");
    expect(requested).not.toContain("/api/v1/local-consoles");
    expect(requested).toContain("/api/v1/desktop/shell");
  });

  it("asks home to unfold its own list instead of opening this console's", async () => {
    stubRemoteConsole();
    await mount(createElement(HostSwitcher));

    const chip = document.querySelector<HTMLButtonElement>(".host-switcher-chip")!;
    await act(async () => { chip.click(); });

    // 실려 가는 값은 지금 서 있는 콘솔 하나뿐이다 — 남의 기계는 이 URL에 없다.
    expect(assign).toHaveBeenCalledOnce();
    const url = new URL(assign.mock.calls[0]![0] as string);
    expect(url.origin).toBe(HOME);
    expect(url.pathname).toBe("/console/");
    expect(url.searchParams.get("desktop-surface")).toBe("host-picker");
    expect(url.searchParams.get("at")).toBe(HERE);
    // 이 콘솔의 판은 열리지 않는다.
    expect(rows()).toHaveLength(0);
  });
});

describe("the list home unfolds", () => {
  it("shows home's own hosts and marks the console the user is standing on", async () => {
    stubHomeConsole();

    await mount(createElement(HostPickerScreen, { surface: { at: HERE } }));

    expect(rowText().join("\n")).toContain("SBLUEMIN2C23");
    const current = rows().find((row) => row.getAttribute("aria-checked") === "true");
    expect(current?.textContent).toContain("dotobokuliui-Macmini");
    expect((current as HTMLButtonElement).disabled).toBe(false);
    expect(current?.getAttribute("aria-disabled")).toBe("true");
  });

  it("opens with the list already unfolded and no chip of its own", async () => {
    stubHomeConsole();

    await mount(createElement(HostPickerScreen, { surface: { at: HERE } }));

    expect(rows().length).toBeGreaterThan(0);
    expect(document.querySelector(".host-switcher-chip")).toBeNull();
  });

  it("keeps the picker keyboard behind the Add Host modal", async () => {
    stubHomeConsole();
    await mount(createElement(HostPickerScreen, { surface: { at: HERE } }));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });

    const add = document.querySelector<HTMLButtonElement>('.host-switcher-link[role="menuitem"]')!;
    await act(async () => { add.click(); });
    const input = document.querySelector<HTMLInputElement>(".add-host-field input")!;
    expect(document.activeElement).toBe(input);

    for (const key of ["ArrowDown", "Home", "End"]) {
      await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
      expect(document.activeElement).toBe(input);
    }

    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    expect(rows().length).toBeGreaterThan(0);
    expect(assign).not.toHaveBeenCalled();
  });

  it("moves initial focus to a current saved host that arrives after the first frame", async () => {
    standOn(HOME);
    let releaseHosts = (_: Response) => {};
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = new URL(input, HOME).pathname;
      if (path === "/api/v1/desktop/shell") return Response.json({ homeOrigin: HOME });
      if (path === "/api/v1/local-consoles") return Response.json({ consoles: [scanned(HOME)] });
      if (path === "/api/v1/remote-hosts") return new Promise<Response>((resolve) => { releaseHosts = resolve; });
      return Response.json({ reachable: true, trusted: true });
    }));

    await mount(createElement(HostPickerScreen, { surface: { at: THERE } }));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    const fallback = rows().find((row) => row.getAttribute("aria-checked") === "true")!;
    expect(document.activeElement).toBe(fallback);
    expect((fallback as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      releaseHosts(Response.json({
        hosts: [{ id: "there", label: "SBLUEMIN2C23", origin: THERE, hostname: "10.211.55.3", port: 6186, fingerprint: "A".repeat(64), addedAt: 1, lastOpenedAt: null }],
      }));
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });

    const current = rows().find((row) => row.getAttribute("aria-checked") === "true")!;
    expect(current.textContent).toContain("SBLUEMIN2C23");
    expect(document.activeElement).toBe(current);
  });

  it("focuses the current row and moves through enabled actions with menu keys", async () => {
    stubHomeConsole();

    await mount(createElement(HostPickerScreen, { surface: { at: HERE } }));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });

    const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], [role="menuitem"]')]
      .filter((item) => !item.disabled);
    const current = items.find((item) => item.getAttribute("aria-checked") === "true")!;
    expect(document.activeElement).toBe(current);

    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    expect(document.activeElement).toBe(items[(items.indexOf(current) + 1) % items.length]);

    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })); });
    expect(document.activeElement).toBe(items.at(-1));

    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })); });
    expect(document.activeElement).toBe(items[0]);
  });

  /** 판은 이 화면의 상태가 아니라 셸이 얹은 덮개라, 접겠다는 말도 셸에게 가야 한다. */
  it("tells the shell to take the cover down instead of just hiding the list", async () => {
    stubHomeConsole();
    await mount(createElement(HostPickerScreen, { surface: { at: HERE } }));

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(assign).toHaveBeenCalledOnce();
    const url = new URL(assign.mock.calls[0]![0] as string);
    expect(url.origin).toBe(HOME);
    expect(url.searchParams.get("desktop-surface")).toBe("host-picker-dismiss");
  });

  it("sends the window to the chosen console", async () => {
    stubHomeConsole();
    await mount(createElement(HostPickerScreen, { surface: { at: HERE } }));

    const target = rows().find((row) => row.textContent?.includes("SBLUEMIN2C23"))!;
    await act(async () => { target.click(); });

    expect(assign).toHaveBeenCalledWith(`${THERE}/console/`);
  });

  /**
   * 데이터 루트를 재지정한 콘솔(격리 실행 등)은 정규 슬롯에 락을 두지 않으므로 스캔이 자기
   * 자신도 찾지 못한다. 그때 스캔의 침묵을 사망으로 읽으면 살아 있는 집이 목록에서 사라지고,
   * 원격에서 펼친 이 화면에는 돌아갈 줄이 하나도 남지 않는다.
   */
  it("keeps home on the list when the scan cannot see the console serving it", async () => {
    stubHomeConsole([scanned(NEIGHBOUR)]);

    await mount(createElement(HostPickerScreen, { surface: { at: THERE } }));

    const home = rows().find((row) => row.textContent?.includes(new URL(HOME).host));
    expect(home).toBeDefined();
    expect(home!.className).toContain("is-home");
  });
});

/**
 * WSL 안의 콘솔은 `127.0.0.1`로 열리지만 그 콘솔이 도는 곳은 Windows 쪽을 볼 수 없는 다른
 * 기계다 — 그쪽 스캔은 이 기계의 콘솔을 원리적으로 찾지 못한다. 주소 모양에는 그 경계가
 * 드러나지 않으므로, 집인지 아닌지는 셸이 말한 집 주소와의 비교만이 답한다.
 */
describe("host box on a loopback console that is not home", () => {
  const GUEST = "http://127.0.0.1:2253";

  it("asks home to unfold its list instead of opening this console's", async () => {
    stubLoopbackConsole(GUEST, [scanned(GUEST)]);

    await mount(createElement(HostSwitcher));
    await act(async () => { document.querySelector<HTMLButtonElement>(".host-switcher-chip")!.click(); });

    expect(assign).toHaveBeenCalledOnce();
    const url = new URL(assign.mock.calls[0]![0] as string);
    expect(url.origin).toBe(HOME);
    expect(url.pathname).toBe("/console/");
    expect(url.searchParams.get("desktop-surface")).toBe("host-picker");
    expect(url.searchParams.get("at")).toBe(GUEST);
    // 이 콘솔의 판은 열리지 않는다 — 목록은 집의 것이다.
    expect(rows()).toHaveLength(0);
  });

  /** 칩이 "여기"라고 말하면 집을 떠나 있다는 사실이 사라진다. */
  it("names the console it is standing on instead of calling it local", async () => {
    stubLoopbackConsole(GUEST, [scanned(GUEST)]);

    await mount(createElement(HostSwitcher));

    expect(document.querySelector(".host-switcher-chip")!.textContent).toContain("127.0.0.1:2253");
  });

  /**
   * 집 주소는 창보다 늦게 도착할 수 있다. 그 사이 "여기"라고 말하면 손님 콘솔이 집 행세를
   * 하고, 사용자는 그 말을 믿고 눌러 남의 목록을 편다. 모를 때는 아무 말도 하지 않는다.
   */
  it("does not call itself local while it has not been told where home is", async () => {
    standOn(GUEST);
    let tellHome = (_: Response) => {};
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = new URL(input, GUEST).pathname;
      if (path === "/api/v1/desktop/shell") return new Promise<Response>((resolve) => { tellHome = resolve; });
      if (path === "/api/v1/local-consoles") return Response.json({ consoles: [scanned(GUEST)] });
      if (path === "/api/v1/remote-hosts") return Response.json({ hosts: [] });
      return Response.json({ reachable: true, trusted: true });
    }));

    await mount(createElement(HostSwitcher));

    // 아직 답이 오지 않았다 — 이 콘솔은 자기가 집이라고 주장하지 않는다.
    expect(document.querySelector(".host-switcher-chip")!.textContent).not.toContain("Local");

    // 그새 눌러 이 콘솔의 판이 열렸더라도, 집 주소가 도착하면 그 판은 남의 목록이므로 걷힌다.
    await act(async () => { document.querySelector<HTMLButtonElement>(".host-switcher-chip")!.click(); });
    expect(assign).not.toHaveBeenCalled();

    await act(async () => { tellHome(Response.json({ homeOrigin: HOME })); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    expect(rows()).toHaveLength(0);
    // 누름은 사라지지 않는다 — 뜻대로 집의 목록을 청한다.
    expect(assign).toHaveBeenCalledOnce();
    const url = new URL(assign.mock.calls[0]![0] as string);
    expect(url.origin).toBe(HOME);
    expect(url.searchParams.get("desktop-surface")).toBe("host-picker");
    expect(url.searchParams.get("at")).toBe(GUEST);
  });

  /** 집이 그린 판에서도 손님 줄은 손님의 이름을 달아야 한다. */
  it("does not lend the serving console's own name to the guest row", async () => {
    stubHomeConsole([scanned(HOME), { origin: GUEST, version: "1.52.0", owner: "cli", distro: "Ubuntu-26.04" }]);

    await mount(createElement(HostPickerScreen, { surface: { at: GUEST } }));

    const current = rows().find((row) => row.getAttribute("aria-checked") === "true");
    expect(current?.textContent).toContain("Ubuntu-26.04");
    expect(current?.textContent).not.toContain(new URL(HOME).host);
    // 이름을 지어 준 적이 없으면 그 줄은 자기 폴백을 쓴다 — 주소는 상세가 이미 말한다.
    expect(current?.textContent).toContain("Fleet Console");
  });
});

/**
 * 스캔이 답했는데 그 안에 집이 없다는 사실은, 셸이 끼어들지 않은 화면에서만 사망의 증거가
 * 된다 — 그 판정은 위 완화 뒤에도 그대로 남아야 한다. 셸이 창을 들고 있으면 목록을 그리는
 * 쪽이 집이므로, 이 콘솔의 스캔이 무엇을 못 봤는지는 그 동선을 가로막지 못한다.
 */
describe("a home the scan disproves", () => {
  it("does not stand a row on a console that is not home", async () => {
    delete document.documentElement.dataset.desktopShell;
    stubLoopbackConsole(NEIGHBOUR, [scanned(NEIGHBOUR)]);

    await mount(createElement(HostSwitcher));
    await act(async () => { document.querySelector<HTMLButtonElement>(".host-switcher-chip")!.click(); });

    expect(rowText().some((text) => text.includes(new URL(HOME).host))).toBe(false);
  });
});

/**
 * 설정 페이지 은퇴 뒤의 "호스트 관리..." 두 갈래. 집에서는 레일의 설정 표면을 연결 섹션으로
 * 소환하고, 덮개(피커)에서는 창째로 집의 옛 주소에 보낸다 — 그 주소는 라우트 어댑터가 같은
 * 표면으로 번역한다. 두 쪽이 따로 표류하면 한쪽 관리 문이 조용히 죽는다.
 */
describe("the manage door after the settings page retired", () => {
  function manageLink(): HTMLButtonElement {
    const link = [...document.querySelectorAll<HTMLButtonElement>(".host-switcher-link")]
      .find((button) => (button.textContent ?? "").startsWith("Manage"));
    expect(link, "manage link").toBeDefined();
    return link!;
  }

  it("summons the settings surface at connectivity from the home list", async () => {
    __resetPaneStoreForTests();
    {
      const active = getRailStoreSnapshot().activePanelId;
      if (active !== null) closeRailPanel(active);
    }
    setRailChromeExpanded(false);
    stubHomeConsole();

    await mount(createElement(HostSwitcher));
    await act(async () => { document.querySelector<HTMLButtonElement>(".host-switcher-chip")!.click(); });
    await act(async () => { manageLink().click(); });

    expect(getRailStoreSnapshot().activePanelId).toBe("settings");
    expect(getRailStoreSnapshot().railChromeExpanded).toBe(true);
    expect(getPaneStoreSnapshot().rail[0]?.paneId).toBe("settings");
    expect(getPaneStoreSnapshot().rail[0]?.params).toEqual({ section: "connectivity" });
    // 집의 표면을 열었으니 창은 어디로도 항해하지 않는다.
    expect(assign).not.toHaveBeenCalled();
  });

  it("sends the picker fork home through the legacy settings address", async () => {
    stubHomeConsole();

    await mount(createElement(HostPickerScreen, { surface: { at: HERE } }));
    await act(async () => { manageLink().click(); });

    expect(assign).toHaveBeenCalledWith(expect.stringContaining("/console/settings?section=remote-access"));
  });
});
