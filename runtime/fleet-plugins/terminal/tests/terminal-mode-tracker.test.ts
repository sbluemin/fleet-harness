import { describe, expect, it } from "vitest";

import { createTerminalModeTracker } from "../server/shared/terminal-mode-tracker.js";

const bytes = (value: string) => Buffer.from(value, "utf8");

describe("terminal mode tracker", () => {
  it("tracks alternate screen and mouse modes across split PTY chunks", () => {
    const tracker = createTerminalModeTracker();

    tracker.push(bytes("\x1b[?10"));
    tracker.push(bytes("49h\x1b[?1000;1006h"));

    expect(tracker.snapshot()).toEqual({
      alternateScreenActive: true,
      mouseProtocol: "vt200",
      mouseEncoding: "sgr",
    });
  });

  it("accepts all standard alternate buffer modes and restores normal mode", () => {
    for (const mode of [47, 1047, 1049]) {
      const tracker = createTerminalModeTracker();
      tracker.push(bytes(`\x1b[?${mode}h`));
      expect(tracker.snapshot().alternateScreenActive).toBe(true);
      tracker.push(bytes(`\x1b[?${mode}l`));
      expect(tracker.snapshot().alternateScreenActive).toBe(false);
    }
  });

  it("resets all tracked modes on RIS without mistaking OSC payloads for CSI", () => {
    const tracker = createTerminalModeTracker();
    tracker.push(bytes("\x1b]0;literal [ ? 1049 h title\x07"));
    expect(tracker.snapshot().alternateScreenActive).toBe(false);
    tracker.push(bytes("\x1b[?1049;1000;1006h"));

    tracker.push(bytes("\x1bc"));

    expect(tracker.snapshot()).toEqual({
      alternateScreenActive: false,
      mouseProtocol: "none",
      mouseEncoding: "default",
    });
  });
});
