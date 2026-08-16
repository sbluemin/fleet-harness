import { beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchUpdateCommand } from "../../cli/update/dispatcher.js";
import { readFleetCliRelease } from "../../cli/release.js";
import { checkUpdateStatus } from "../../cli/update/check.js";

vi.mock("../../cli/release.js", () => ({
  readFleetCliRelease: vi.fn(),
}));

vi.mock("../../cli/update/check.js", () => ({
  checkUpdateStatus: vi.fn(),
  resolveUpdateChannel: vi.fn(() => "latest"),
}));

const mockedReadFleetCliRelease = vi.mocked(readFleetCliRelease);
const mockedCheckUpdateStatus = vi.mocked(checkUpdateStatus);

describe("fleet update --check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedReadFleetCliRelease.mockReturnValue({ channel: "stable", version: "1.2.0" });
    mockedCheckUpdateStatus.mockResolvedValue({ status: "current", latest: "1.2.0" });
  });

  it("documents --check in help", async () => {
    const io = createIo();
    await expect(dispatchUpdateCommand(["update", "--help"], io)).resolves.toBe(0);
    expect(io.stdout.output).toContain("fleet update --check");
  });

  it("still rejects the bare check verb", async () => {
    const io = createIo();
    await expect(dispatchUpdateCommand(["update", "check"], io)).resolves.toBe(1);
    expect(io.stderr.output).toContain("Unknown fleet update command: check");
    expect(mockedCheckUpdateStatus).not.toHaveBeenCalled();
  });

  it("reports a newer version without installing", async () => {
    const io = createIo();
    mockedCheckUpdateStatus.mockResolvedValue({ status: "update", latest: "1.3.0" });
    await expect(dispatchUpdateCommand(["update", "--check"], io)).resolves.toBe(0);
    expect(io.stdout.output).toBe(
      "A newer Fleet version is available: v1.3.0 (installed v1.2.0).\nRun fleet update to install it.\n",
    );
    expect(mockedCheckUpdateStatus).toHaveBeenCalledWith({ channel: "stable", version: "1.2.0" }, { forceRefresh: true });
  });

  it("does not contact the registry for a local build", async () => {
    const io = createIo();
    mockedReadFleetCliRelease.mockReturnValue({ channel: "local", version: "1.62.0" });
    await expect(dispatchUpdateCommand(["update", "--check"], io)).resolves.toBe(0);
    expect(io.stdout.output).toContain("local development build (v1.62.0)");
    expect(mockedCheckUpdateStatus).not.toHaveBeenCalled();
  });
});

function createIo() {
  const stdout = { output: "", write(chunk: string) { stdout.output += chunk; return true; } };
  const stderr = { output: "", write(chunk: string) { stderr.output += chunk; return true; } };
  return { stdout, stderr };
}
