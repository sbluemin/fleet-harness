import { fetchLatestVersion } from "@dotobokuri/core-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchLatestFleetCliVersion } from "../../cli/update/registry.js";

vi.mock("@dotobokuri/core-agent", async (importOriginal) => ({
  ...await importOriginal<typeof import("@dotobokuri/core-agent")>(),
  fetchLatestVersion: vi.fn(),
}));

const mockedFetchLatestVersion = vi.mocked(fetchLatestVersion);

describe("update registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFetchLatestVersion.mockResolvedValue(undefined);
  });

  it("delegates fleet-console registry lookup to the shared core-agent helper", async () => {
    mockedFetchLatestVersion.mockResolvedValue("1.2.3");

    await expect(fetchLatestFleetCliVersion("latest")).resolves.toBe("1.2.3");

    expect(mockedFetchLatestVersion).toHaveBeenCalledWith("@dotobokuri/fleet-console", "latest");
  });
});
