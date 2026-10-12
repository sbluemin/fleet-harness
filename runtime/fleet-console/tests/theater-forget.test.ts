import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  failAddTheater: vi.fn(),
  fetchGroups: vi.fn(),
  fetchOperations: vi.fn(),
  forgetTheater: vi.fn(),
  getState: vi.fn(),
  hydrateGroups: vi.fn(),
  hydrateOperations: vi.fn(),
  removeTheater: vi.fn(),
}));

vi.mock("../core/client/src/integration/api.js", () => ({
  fetchGroups: mocks.fetchGroups,
  fetchOperations: mocks.fetchOperations,
  forgetTheater: mocks.forgetTheater,
}));

vi.mock("../core/client/src/integration/store.js", () => ({
  failAddTheater: mocks.failAddTheater,
  getState: mocks.getState,
  hydrateGroups: mocks.hydrateGroups,
  hydrateOperations: mocks.hydrateOperations,
  removeTheater: mocks.removeTheater,
}));

import { forgetTheaterCompletely } from "../features/workspace/client/theater.js";

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
  mocks.getState.mockReturnValue({ activeTheaterId: null, theaters: [{ id: "theater-a" }] });
});

describe("forgetTheaterCompletely", () => {
  it("returns the receipt and clears local Theater state after a successful forget", async () => {
    await expect(forgetTheaterCompletely("theater-a")).resolves.toEqual(RECEIPT);

    expect(mocks.forgetTheater).toHaveBeenCalledWith("theater-a");
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
    expect(mocks.removeTheater).not.toHaveBeenCalled();
  });

  it("preserves the receipt when collection rehydration fails", async () => {
    mocks.fetchOperations.mockRejectedValue(new Error("refresh failed"));

    await expect(forgetTheaterCompletely("theater-a")).resolves.toEqual(RECEIPT);

    expect(mocks.removeTheater).toHaveBeenCalledWith("theater-a");
    expect(mocks.failAddTheater).not.toHaveBeenCalled();
  });
});
