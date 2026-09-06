import { describe, expect, it, vi } from "vitest";

import { createTerminalLinkHandler, TERMINAL_OPTIONS } from "../client/shared/terminal-options.js";

describe("TERMINAL_OPTIONS", () => {

  it("opens OSC 8 HTTP links with the URL in the initial popup request", () => {
    const openWindow = vi.fn();
    const confirmNavigation = vi.fn(() => true);
    const handler = createTerminalLinkHandler(openWindow, confirmNavigation);

    handler.activate({} as MouseEvent, "http://127.0.0.1:4173/preview");
    handler.activate({} as MouseEvent, "https://fleet.example/docs");

    expect(openWindow).toHaveBeenNthCalledWith(1, "http://127.0.0.1:4173/preview", "_blank", "noopener,noreferrer");
    expect(openWindow).toHaveBeenNthCalledWith(2, "https://fleet.example/docs", "_blank", "noopener,noreferrer");
    expect(confirmNavigation).toHaveBeenNthCalledWith(1, "http://127.0.0.1:4173/preview");
    expect(confirmNavigation).toHaveBeenNthCalledWith(2, "https://fleet.example/docs");
  });

  it("rejects non-web and malformed OSC 8 links", () => {
    const openWindow = vi.fn();
    const confirmNavigation = vi.fn(() => true);
    const handler = createTerminalLinkHandler(openWindow, confirmNavigation);

    handler.activate({} as MouseEvent, "file:///tmp/secret");
    handler.activate({} as MouseEvent, "javascript:alert('unsafe')");
    handler.activate({} as MouseEvent, "not a url");

    expect(openWindow).not.toHaveBeenCalled();
    expect(confirmNavigation).not.toHaveBeenCalled();
  });

  it("does not open an OSC 8 link when navigation is declined", () => {
    const openWindow = vi.fn();
    const handler = createTerminalLinkHandler(openWindow, () => false);

    handler.activate({} as MouseEvent, "https://fleet.example/docs");

    expect(openWindow).not.toHaveBeenCalled();
  });
});
