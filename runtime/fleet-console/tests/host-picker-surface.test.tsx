// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://192.168.0.62:63371/console/" }

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostSwitcher, readHostPickerSurface } from "../core/client/src/components/command-band-system-cluster.js";
import { HostPickerScreen } from "../core/client/src/components/host-picker-surface.js";

const HOME = "http://127.0.0.1:59229";
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

/** 집이 자기 루프백에서 목록을 내주는 화면. */
function stubHomeConsole(): void {
  standOn(HOME);
  requested = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const path = new URL(input, HOME).pathname;
    requested.push(path);
    if (path === "/api/v1/desktop/shell") return Response.json({ homeOrigin: HOME });
    if (path === "/api/v1/local-consoles") {
      return Response.json({ consoles: [{ origin: HOME, version: "1.51.0", owner: "desktop", distro: null }] });
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
    expect((current as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens with the list already unfolded and no chip of its own", async () => {
    stubHomeConsole();

    await mount(createElement(HostPickerScreen, { surface: { at: HERE } }));

    expect(rows().length).toBeGreaterThan(0);
    expect(document.querySelector(".host-switcher-chip")).toBeNull();
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
});
