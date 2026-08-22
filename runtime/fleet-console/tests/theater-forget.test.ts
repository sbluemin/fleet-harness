import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  failAddTheater: vi.fn(),
  fetchGroups: vi.fn(),
  fetchOperations: vi.fn(),
  forgetTheater: vi.fn(),
  getState: vi.fn(),
  hydrateGroups: vi.fn(),
  hydrateOperations: vi.fn(),
  isTriageActive: vi.fn(),
  removeTheater: vi.fn(),
  resetTriageTheater: vi.fn(),
  visitTriageTheater: vi.fn(),
}));

vi.mock("../core/client/src/api.js", () => ({
  fetchGroups: mocks.fetchGroups,
  fetchOperations: mocks.fetchOperations,
  forgetTheater: mocks.forgetTheater,
}));

vi.mock("../core/client/src/canvas/triage-store.js", () => ({
  isTriageActive: mocks.isTriageActive,
  resetTriageTheater: mocks.resetTriageTheater,
  visitTriageTheater: mocks.visitTriageTheater,
}));

vi.mock("../core/client/src/store.js", () => ({
  failAddTheater: mocks.failAddTheater,
  getState: mocks.getState,
  hydrateGroups: mocks.hydrateGroups,
  hydrateOperations: mocks.hydrateOperations,
  removeTheater: mocks.removeTheater,
}));

import { forgetTheaterCompletely } from "../core/client/src/theater.js";

const RECEIPT = {
  deletionId: "deletion-theater-a",
  kind: "theater",
  targetId: "theater-a",
  expiresAt: 12_345,
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchOperations.mockResolvedValue([]);
  mocks.fetchGroups.mockResolvedValue([]);
  mocks.forgetTheater.mockResolvedValue({ ok: true, deletion: RECEIPT });
  mocks.isTriageActive.mockReturnValue(false);
  mocks.getState.mockReturnValue({ activeTheaterId: null });
});

describe("forgetTheaterCompletely", () => {
  it("returns the receipt and clears triage and local Theater state after a successful forget", async () => {
    await expect(forgetTheaterCompletely("theater-a")).resolves.toEqual(RECEIPT);

    expect(mocks.forgetTheater).toHaveBeenCalledWith("theater-a");
    expect(mocks.resetTriageTheater).toHaveBeenCalledWith("theater-a");
    expect(mocks.removeTheater).toHaveBeenCalledWith("theater-a");
    expect(mocks.fetchOperations).toHaveBeenCalledWith(null);
    expect(mocks.fetchGroups).toHaveBeenCalledWith(null);
    expect(mocks.hydrateOperations).toHaveBeenCalledWith([]);
    expect(mocks.hydrateGroups).toHaveBeenCalledWith([]);
  });

  it("reports an API failure and returns null", async () => {
    mocks.forgetTheater.mockRejectedValue(new Error("forget failed"));

    await expect(forgetTheaterCompletely("theater-a")).resolves.toBeNull();

    expect(mocks.failAddTheater).toHaveBeenCalledWith("forget failed");
    expect(mocks.resetTriageTheater).not.toHaveBeenCalled();
    expect(mocks.removeTheater).not.toHaveBeenCalled();
  });

  it("preserves the receipt when collection rehydration fails", async () => {
    mocks.fetchOperations.mockRejectedValue(new Error("refresh failed"));

    await expect(forgetTheaterCompletely("theater-a")).resolves.toEqual(RECEIPT);

    expect(mocks.resetTriageTheater).toHaveBeenCalledWith("theater-a");
    expect(mocks.removeTheater).toHaveBeenCalledWith("theater-a");
    expect(mocks.failAddTheater).not.toHaveBeenCalled();
  });
});
