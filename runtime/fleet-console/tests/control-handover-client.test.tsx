// @vitest-environment jsdom

import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ControlBar } from "../core/client/src/components/control-bar.js";
import { ControlCurtain } from "../core/client/src/components/control-curtain.js";
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
});

function renderControlSurfaces(): void {
  act(() => root?.render(createElement(
    "div",
    { className: "console-shell" },
    createElement(Fragment, null, createElement(ControlBar), createElement(ControlCurtain)),
  )));
}
