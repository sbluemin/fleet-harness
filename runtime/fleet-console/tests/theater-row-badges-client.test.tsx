// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  normalizeBadgeResponse,
  THEATER_ROW_BADGE_REFRESH_MS,
  useTheaterRowBadges,
} from "../core/client/src/sidebar/theater-row-badges.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
  root = null;
  container = null;
});

describe("Theater row badge client", () => {
  it("refreshes immediately, every 30 seconds, on focus, and when Theater registration changes", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ theaters: [{ theaterId: "one", badges: [{ id: "branch", text: "main", tone: "neutral" }] }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await renderHarness(["one"], false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container?.textContent).toContain("main");

    await act(async () => {
      vi.advanceTimersByTime(THEATER_ROW_BADGE_REFRESH_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await renderHarness(["one", "two"], false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not poll while the sidebar is collapsed or the document is hidden", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ theaters: [] }) }));
    vi.stubGlobal("fetch", fetchMock);

    await renderHarness(["one"], true);
    await act(async () => {
      vi.advanceTimersByTime(THEATER_ROW_BADGE_REFRESH_MS * 2);
      window.dispatchEvent(new Event("focus"));
    });
    expect(fetchMock).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await renderHarness(["one"], false);
    await act(async () => {
      vi.advanceTimersByTime(THEATER_ROW_BADGE_REFRESH_MS * 2);
      window.dispatchEvent(new Event("focus"));
    });
    expect(fetchMock).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts only known Theater contributions and supported tones", () => {
    expect(normalizeBadgeResponse({
      theaters: [
        { theaterId: "unknown", badges: [{ id: "branch", text: "secret" }] },
        { theaterId: "known", badges: [
          { id: "branch", text: "main", tone: "neutral" },
          { id: "bad", text: "bad", tone: "identity" },
        ] },
      ],
    }, ["known"])).toEqual({
      known: [{ id: "branch", text: "main", tone: "neutral" }],
    });
  });
});

function BadgeHarness({ theaterIds, collapsed }: { readonly theaterIds: readonly string[]; readonly collapsed: boolean }) {
  return createElement("pre", null, JSON.stringify(useTheaterRowBadges(theaterIds, collapsed)));
}

async function renderHarness(theaterIds: readonly string[], collapsed: boolean): Promise<void> {
  await act(async () => {
    root?.render(createElement(BadgeHarness, { theaterIds, collapsed }));
  });
}
