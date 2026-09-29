import { beforeEach, describe, expect, it, vi } from "vitest";

import { readCachedLatestVersion, writeCachedLatestVersion } from "../../cli/update/cache.js";
import { checkForUpdate, checkUpdateStatus } from "../../cli/update/check.js";
import { fetchFleetCliRelease } from "../../cli/update/registry.js";

vi.mock("../../cli/update/cache.js", () => ({
  readCachedLatestVersion: vi.fn(),
  writeCachedLatestVersion: vi.fn(),
}));

vi.mock("../../cli/update/registry.js", () => ({
  fetchFleetCliRelease: vi.fn(),
}));

const mockedFetchFleetCliRelease = vi.mocked(fetchFleetCliRelease);
const RELEASE_1_3_0 = {
  schema: 1,
  package: "@dotobokuri/fleet-console",
  version: "1.3.0",
  tag: "v1.3.0",
  tarball: { name: "fleet-console-1.3.0.tgz", size: 1, sha256: "0".repeat(64) },
} as const;
const mockedReadCachedLatestVersion = vi.mocked(readCachedLatestVersion);
const mockedWriteCachedLatestVersion = vi.mocked(writeCachedLatestVersion);

describe("update check status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedReadCachedLatestVersion.mockReturnValue(undefined);
    mockedFetchFleetCliRelease.mockResolvedValue({ ok: false, reason: "unreachable" });
  });

  it("does not let stale cache make explicit update checks falsely current", async () => {
    mockedReadCachedLatestVersion.mockReturnValue("1.2.0");
    mockedFetchFleetCliRelease.mockResolvedValue({ ok: true, manifest: RELEASE_1_3_0 });

    await expect(checkUpdateStatus({ channel: "stable", version: "1.2.0" }, { forceRefresh: true, env: {} })).resolves.toEqual({
      status: "update",
      latest: "1.3.0",
      release: RELEASE_1_3_0,
    });

    expect(mockedReadCachedLatestVersion).not.toHaveBeenCalled();
    expect(mockedWriteCachedLatestVersion).toHaveBeenCalledWith("latest", "1.3.0");
  });

  it("returns unavailable when a forced release check cannot read the manifest", async () => {
    mockedReadCachedLatestVersion.mockReturnValue("1.2.0");

    await expect(checkUpdateStatus({ channel: "stable", version: "1.2.0" }, { forceRefresh: true, env: {} })).resolves.toEqual({
      status: "unavailable",
    });

    expect(mockedReadCachedLatestVersion).not.toHaveBeenCalled();
    expect(mockedWriteCachedLatestVersion).not.toHaveBeenCalled();
  });
});
