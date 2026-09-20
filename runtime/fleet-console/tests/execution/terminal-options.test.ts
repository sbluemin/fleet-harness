import { describe, expect, it, vi } from "vitest";

import { createTerminalLinkRoute } from "../../features/execution/client/terminal/shared/terminal-options.js";

/** 링크 경로 하나가 OSC 8 하이퍼링크와 출력에서 찾아낸 맨 URL을 함께 받는다. */
function route(chooseTarget: (url: string, event: MouseEvent) => boolean) {
  const openWindow = vi.fn();
  const confirmNavigation = vi.fn(() => true);
  return { activate: createTerminalLinkRoute({ chooseTarget, openWindow, confirmNavigation }), openWindow, confirmNavigation };
}

describe("terminal link route", () => {
  it("hands a web link to the surface's chooser instead of opening it", () => {
    const chooseTarget = vi.fn(() => true);
    const { activate, openWindow, confirmNavigation } = route(chooseTarget);

    activate({} as MouseEvent, "https://fleet.example/docs");

    expect(chooseTarget).toHaveBeenCalledWith("https://fleet.example/docs", expect.anything());
    expect(openWindow).not.toHaveBeenCalled();
    expect(confirmNavigation).not.toHaveBeenCalled();
  });

  it("confirms and opens in a new window when the surface has no chooser", () => {
    const { activate, openWindow, confirmNavigation } = route(() => false);

    activate({} as MouseEvent, "http://127.0.0.1:4173/preview");

    expect(confirmNavigation).toHaveBeenCalledWith("http://127.0.0.1:4173/preview");
    // xterm's default OSC 8 handler opens about:blank first; sandboxed Desktop denies that blank
    // popup, so the validated URL travels in the initial request.
    expect(openWindow).toHaveBeenCalledWith("http://127.0.0.1:4173/preview", "_blank", "noopener,noreferrer");
  });

  it("does not open a link when navigation is declined", () => {
    const openWindow = vi.fn();
    const activate = createTerminalLinkRoute({ chooseTarget: () => false, openWindow, confirmNavigation: () => false });

    activate({} as MouseEvent, "https://fleet.example/docs");

    expect(openWindow).not.toHaveBeenCalled();
  });

  it("rejects non-web and malformed links before anything can open them", () => {
    const chooseTarget = vi.fn(() => true);
    const { activate, openWindow, confirmNavigation } = route(chooseTarget);

    activate({} as MouseEvent, "file:///tmp/secret");
    activate({} as MouseEvent, "javascript:alert('unsafe')");
    activate({} as MouseEvent, "not a url");

    expect(chooseTarget).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
    expect(confirmNavigation).not.toHaveBeenCalled();
  });
});
