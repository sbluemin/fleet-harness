import { beforeEach, describe, expect, it, vi } from "vitest";

import { readCachedLatestVersion, writeCachedLatestVersion } from "../../cli/update/cache.js";
import { checkForUpdate, checkUpdateStatus } from "../../cli/update/check.js";
import { fetchLatestFleetCliVersion } from "../../cli/update/registry.js";

vi.mock("../../cli/update/cache.js", () => ({
  readCachedLatestVersion: vi.fn(),
  writeCachedLatestVersion: vi.fn(),
}));

vi.mock("../../cli/update/registry.js", () => ({
  fetchLatestFleetCliVersion: vi.fn(),
}));

const mockedFetchLatestFleetCliVersion = vi.mocked(fetchLatestFleetCliVersion);
const mockedReadCachedLatestVersion = vi.mocked(readCachedLatestVersion);
const mockedWriteCachedLatestVersion = vi.mocked(writeCachedLatestVersion);

describe("update check status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedReadCachedLatestVersion.mockReturnValue(undefined);
    mockedFetchLatestFleetCliVersion.mockResolvedValue(undefined);
  });

  it("does not let stale cache make explicit update checks falsely current", async () => {
    mockedReadCachedLatestVersion.mockReturnValue("1.2.0");
    mockedFetchLatestFleetCliVersion.mockResolvedValue("1.3.0");

    await expect(checkUpdateStatus({ channel: "stable", version: "1.2.0" }, { forceRefresh: true })).resolves.toEqual({
      status: "update",
      latest: "1.3.0",
    });

    expect(mockedReadCachedLatestVersion).not.toHaveBeenCalled();
    expect(mockedFetchLatestFleetCliVersion).toHaveBeenCalledWith("latest");
    expect(mockedWriteCachedLatestVersion).toHaveBeenCalledWith("latest", "1.3.0");
  });

  it("returns unavailable when a forced registry check cannot resolve latest", async () => {
    mockedReadCachedLatestVersion.mockReturnValue("1.2.0");
    mockedFetchLatestFleetCliVersion.mockResolvedValue(undefined);

    await expect(checkUpdateStatus({ channel: "stable", version: "1.2.0" }, { forceRefresh: true })).resolves.toEqual({
      status: "unavailable",
    });

    expect(mockedReadCachedLatestVersion).not.toHaveBeenCalled();
    expect(mockedWriteCachedLatestVersion).not.toHaveBeenCalled();
  });
});
