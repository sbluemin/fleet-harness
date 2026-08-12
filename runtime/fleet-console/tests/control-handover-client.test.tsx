// @vitest-environment jsdom

import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ControlBar } from "../core/client/src/components/control-bar.js";
import { ControlCurtain } from "../core/client/src/components/control-curtain.js";
import { ControlReclaimedNotice } from "../core/client/src/components/control-reclaimed-notice.js";
import { CONTROL_RECLAIMED_EVENT } from "../core/client/src/control-session.js";
import { applyControlHolder, dismissControlCurtain, getState, setState } from "../core/client/src/store.js";
import type { ControlHolder } from "../core/client/src/types.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const holder: ControlHolder = { handle: "remote-a", device: "Kitchen iPad", openedAt: Date.now() - 60_000 };

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.replaceChildren();
  setState({ controlHolder: null, controlCurtainDismissed: false });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  setState({ controlHolder: null, controlCurtainDismissed: false });
});

describe("remote control handover client", () => {
  it("moves a dismissed holder from the curtain to the persistent bar", () => {
    applyControlHolder(holder);
    renderControlSurfaces();

    expect(document.querySelector(".control-curtain-card")?.textContent).toContain("Kitchen iPad has control");
    expect(document.querySelector(".control-bar")).toBeNull();

    const keepWatching = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Keep watching");
    act(() => keepWatching?.click());

    expect(document.querySelector(".control-curtain")).toBeNull();
    expect(document.querySelector(".control-bar")?.textContent).toContain("Kitchen iPad has control");
  });

  it("raises a fresh curtain only when the holder handle changes", () => {
    applyControlHolder(holder);
    dismissControlCurtain();

    applyControlHolder({ ...holder, device: "Renamed iPad", openedAt: holder.openedAt + 1 });
    expect(getState().controlCurtainDismissed).toBe(true);

    applyControlHolder({ ...holder, handle: "remote-b" });
    expect(getState().controlCurtainDismissed).toBe(false);

    applyControlHolder(null);
    expect(getState().controlHolder).toBeNull();
    expect(getState().controlCurtainDismissed).toBe(false);
  });

  it("makes the console shell inert while the curtain is open and restores it on unmount", () => {
    applyControlHolder(holder);
    renderControlSurfaces();
    const shell = document.querySelector<HTMLElement>(".console-shell")!;

    expect(shell.inert).toBe(true);
    act(() => dismissControlCurtain());
    expect(shell.inert).toBe(false);
  });

  /**
   * 끊긴 기기가 읽는 문장은 사유에 따라 갈린다. 다른 기기가 자리를 이어받았을 뿐인데
   * "회수되었습니다"가 뜨면, 이어받은 기기를 찾아가야 할 사람이 콘솔 주인을 의심한다.
   */
  it.each([
    ["reclaimed", "Control was taken back"],
    ["superseded", "Another device connected"],
  ])("names %s as the reason this session ended", (reason, title) => {
    act(() => root?.render(createElement(ControlReclaimedNotice)));
    act(() => { window.dispatchEvent(new CustomEvent(CONTROL_RECLAIMED_EVENT, { detail: { reason } })); });

    expect(document.querySelector(".control-reclaimed-card")?.textContent).toContain(title);
  });

  /** 사유를 읽지 못한 신호도 안내는 띄운다 — 조용히 사라지는 것이 가장 나쁘다. */
  it("falls back to the reclaimed copy when the signal carries no reason", () => {
    act(() => root?.render(createElement(ControlReclaimedNotice)));
    act(() => { window.dispatchEvent(new Event(CONTROL_RECLAIMED_EVENT)); });

    expect(document.querySelector(".control-reclaimed-card")?.textContent).toContain("Control was taken back");
  });
});

function renderControlSurfaces(): void {
  act(() => root?.render(createElement(
    "div",
    { className: "console-shell" },
    createElement(Fragment, null, createElement(ControlBar), createElement(ControlCurtain)),
  )));
}
