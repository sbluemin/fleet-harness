import { describe, expect, it } from "vitest";

import { TERMINAL_OPTIONS } from "../client/shared/terminal-options.js";

describe("TERMINAL_OPTIONS", () => {
  it("preserves raw PTY LF semantics for fullscreen TUI applications", () => {
    expect(TERMINAL_OPTIONS.convertEol).toBe(false);
  });

  it("keeps proposed APIs enabled for the Unicode11 addon", () => {
    expect(TERMINAL_OPTIONS.allowProposedApi).toBe(true);
  });
});
