// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { commandBandRenameCommitTarget, railPathContextDeckOpenAfterCommandBandToggle, shouldCloseCommandBandContextDeck } from "../core/client/src/components/command-band-guards.js";

describe("Command Band v2 guards", () => {
  it("does not commit a previous Operation draft after another panel becomes active", () => {
    const draft = "previous-operation draft";
    const capturedOperationId = "operation-a";
    const activeOperationId = "operation-b";

    expect(draft).toBe("previous-operation draft");
    expect(commandBandRenameCommitTarget(capturedOperationId, activeOperationId)).toBeNull();
  });

  it("keeps the band and rail context decks mutually exclusive in both directions", () => {
    expect(railPathContextDeckOpenAfterCommandBandToggle(true, true)).toBe(false);
    expect(shouldCloseCommandBandContextDeck(true, true)).toBe(true);
    expect(shouldCloseCommandBandContextDeck(true, false)).toBe(false);
  });
});
