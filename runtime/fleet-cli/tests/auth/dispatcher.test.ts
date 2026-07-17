import { beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchAuthCommand } from "../../src/auth/dispatcher.js";

const mocks = vi.hoisted(() => ({
  deleteApiKey: vi.fn(),
  listProviderIds: vi.fn(),
  runAuthLoginFlow: vi.fn(),
}));

vi.mock("../../src/auth/login-flow.js", () => ({
  getAuthCliOptions: () => ["claude-kimi"],
  parseAuthCliId: (value: string | undefined) => value === "claude-kimi" ? value : undefined,
  runAuthLoginFlow: mocks.runAuthLoginFlow,
}));

describe("auth dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteApiKey.mockResolvedValue(true);
    mocks.listProviderIds.mockResolvedValue([]);
    mocks.runAuthLoginFlow.mockResolvedValue(0);
  });

  it("documents the Kimi-only auth surface", async () => {
    const io = createIo();
    await expect(dispatchAuthCommand(["auth", "--help"], io, createDeps())).resolves.toBe(0);
    expect(io.stdout.output).toContain("fleet auth login [claude-kimi]");
  });

  it("dispatches Kimi login", async () => {
    const io = createIo();
    const deps = createDeps();
    await expect(dispatchAuthCommand(["auth", "login", "claude-kimi"], io, deps)).resolves.toBe(0);
    expect(mocks.runAuthLoginFlow).toHaveBeenCalledWith(["claude-kimi"], io, deps);
  });

  it("logs out the stable Kimi provider ID", async () => {
    const io = createIo();
    await expect(dispatchAuthCommand(["auth", "logout", "claude-kimi"], io, createDeps())).resolves.toBe(0);
    expect(mocks.deleteApiKey).toHaveBeenCalledWith("Claude Code with Moonshot Kimi");
    expect(io.stdout.output).toContain("signed out");
  });
});

function createIo() {
  const stdout = { output: "", write(chunk: string) { stdout.output += chunk; return true; } };
  const stderr = { output: "", write(chunk: string) { stderr.output += chunk; return true; } };
  return { stdout, stderr };
}

function createDeps() {
  return {
    authService: {
      deleteApiKey: mocks.deleteApiKey,
      getApiKey: vi.fn(),
      listProviderIds: mocks.listProviderIds,
      setApiKey: vi.fn(),
    },
  };
}
