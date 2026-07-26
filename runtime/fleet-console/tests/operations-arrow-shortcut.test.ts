import { describe, expect, it } from "vitest";

import { resolveOperationsArrowShortcutAction } from "../core/client/src/operations-arrow-shortcut.js";

describe("Operations Alt+Arrow shortcut policy", () => {
  it("makes Alt+Left a no-op and Alt+Right defer-only while Triage is active", () => {
    expect(resolveOperationsArrowShortcutAction(true, "ArrowLeft")).toBe("triage-noop");
    expect(resolveOperationsArrowShortcutAction(true, "ArrowRight")).toBe("triage-defer");
  });

  it("preserves both focus-cycle directions outside Triage", () => {
    expect(resolveOperationsArrowShortcutAction(false, "ArrowLeft")).toBe("focus-previous");
    expect(resolveOperationsArrowShortcutAction(false, "ArrowRight")).toBe("focus-next");
  });

  it("maps vertical arrows to panel actions outside Triage", () => {
    expect(resolveOperationsArrowShortcutAction(false, "ArrowUp")).toBe("maximize-toggle");
    expect(resolveOperationsArrowShortcutAction(false, "ArrowDown")).toBe("minimize");
  });

  it("swallows Alt+Up and routes Alt+Down to set-aside while Triage is active", () => {
    expect(resolveOperationsArrowShortcutAction(true, "ArrowUp")).toBe("triage-noop");
    expect(resolveOperationsArrowShortcutAction(true, "ArrowDown")).toBe("triage-set-aside");
  });
});
