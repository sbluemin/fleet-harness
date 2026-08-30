// @vitest-environment jsdom

import type { ExpandedSurfaceContext } from "@fleet-console/sdk/expanded-surface";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalMocks = vi.hoisted(() => ({ mounted: vi.fn(), unmounted: vi.fn() }));

vi.mock("../client/shared/index.js", () => ({
  TerminalSurface: ({ active }: { readonly active?: boolean }) => {
    useEffect(() => {
      terminalMocks.mounted();
      return () => terminalMocks.unmounted();
    }, []);
    return <div data-testid="terminal-surface" data-active={active ? "true" : "false"} />;
  },
}));

import { PersistentShellHost, shellSurface } from "../client/shell/index.js";

let container: HTMLDivElement;
let root: Root;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  terminalMocks.mounted.mockClear();
  terminalMocks.unmounted.mockClear();
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("persistent Shell mount", () => {
  it("parks one terminal subtree while the pane is closed and reuses it when reopened", () => {
    const context = shellContext();

    act(() => {
      root.render(
        <>
          <PersistentShellHost language="en" theme="instrument" />
          <div className="pane">{shellSurface.render(context)}</div>
        </>,
      );
    });

    expect(terminalMocks.mounted).toHaveBeenCalledTimes(1);
    expect(terminalMocks.unmounted).not.toHaveBeenCalled();
    expect(document.querySelector(".pane .global-shell-persistent-host")).not.toBeNull();
    expect(document.querySelector("[data-testid='terminal-surface']")?.getAttribute("data-active")).toBe("true");

    act(() => {
      root.render(<PersistentShellHost language="en" theme="instrument" />);
    });

    expect(terminalMocks.mounted).toHaveBeenCalledTimes(1);
    expect(terminalMocks.unmounted).not.toHaveBeenCalled();
    expect(document.querySelector(".global-shell-parking .global-shell-persistent-host")).not.toBeNull();
    expect(document.querySelector("[data-testid='terminal-surface']")?.getAttribute("data-active")).toBe("false");

    act(() => {
      root.render(
        <>
          <PersistentShellHost language="en" theme="instrument" />
          <div className="pane">{shellSurface.render(context)}</div>
        </>,
      );
    });

    expect(terminalMocks.mounted).toHaveBeenCalledTimes(1);
    expect(terminalMocks.unmounted).not.toHaveBeenCalled();
    expect(document.querySelector(".pane .global-shell-persistent-host")).not.toBeNull();
    expect(document.querySelector("[data-testid='terminal-surface']")?.getAttribute("data-active")).toBe("true");
  });

  it("closes a split Shell instance without moving the shared terminal", () => {
    const first = shellContext();
    const second = shellContext({ instanceId: "shell#2" });

    act(() => {
      root.render(
        <>
          <PersistentShellHost language="en" theme="instrument" />
          <div className="first-pane">{shellSurface.render(first)}</div>
          <div className="second-pane">{shellSurface.render(second)}</div>
        </>,
      );
    });

    expect(second.close).toHaveBeenCalledTimes(1);
    expect(first.close).not.toHaveBeenCalled();
    expect(terminalMocks.mounted).toHaveBeenCalledTimes(1);
    expect(terminalMocks.unmounted).not.toHaveBeenCalled();
    expect(document.querySelector(".first-pane .global-shell-persistent-host")).not.toBeNull();
    expect(document.querySelector(".second-pane .global-shell-persistent-host")).toBeNull();
  });
});

function shellContext(overrides: Partial<ExpandedSurfaceContext> = {}): ExpandedSurfaceContext {
  return {
    surfaceId: "shell",
    instanceId: "shell#1",
    params: {},
    paneIndex: 0,
    paneCount: 1,
    paneWidth: 900,
    slotIndex: 0,
    slotCount: 1,
    slotWidth: 900,
    focused: true,
    theaterId: "theater-a",
    api: {} as ExpandedSurfaceContext["api"],
    lifecycle: {} as ExpandedSurfaceContext["lifecycle"],
    preferences: {} as ExpandedSurfaceContext["preferences"],
    language: "en",
    theme: "instrument",
    close: vi.fn(),
    focus: vi.fn(),
    replaceParams: vi.fn(),
    ...overrides,
  };
}
