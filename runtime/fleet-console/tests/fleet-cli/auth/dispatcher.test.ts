import { beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchAuthCommand } from "../../../cli/auth/dispatcher.js";

const mocks = vi.hoisted(() => ({
  deleteApiKey: vi.fn(),
  listProviderIds: vi.fn(),
  runAuthLoginFlow: vi.fn(),
}));

vi.mock("../../../cli/auth/login-flow.js", () => ({
  AUTH_CLI_DEFINITIONS: {
    kimi: { label: "Kimi for AI Gateway", shortName: "Kimi", providerId: "Claude Code with Moonshot Kimi" },
    opencode: { label: "OpenCode Go for AI Gateway", shortName: "OpenCode Go", providerId: "Claude Code with OpenCode Go" },
  },
  getAuthCliOptions: () => ["kimi", "opencode"],
  parseAuthCliId: (value: string | undefined) => value === "kimi" || value === "opencode" ? value : undefined,
  resolveAuthCliId: (value: string | undefined, io: { stderr: { write(chunk: string): boolean } }) => {
    if (value === undefined) return undefined;
    if (value === "kimi" || value === "opencode") return value;
    io.stderr.write(`Unknown fleet gateway auth provider: ${value}\nUse kimi or opencode.\n`);
    return "invalid";
  },
  runAuthLoginFlow: mocks.runAuthLoginFlow,
}));

describe("auth dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteApiKey.mockResolvedValue(true);
    mocks.listProviderIds.mockResolvedValue([]);
    mocks.runAuthLoginFlow.mockResolvedValue(0);
  });

  it("documents the provider auth surface", async () => {
    const io = createIo();
    await expect(dispatchAuthCommand(["auth", "--help"], io, createDeps())).resolves.toBe(0);
    expect(io.stdout.output).toContain("fleet gateway auth login [kimi|opencode]");
  });

  it("dispatches Kimi login", async () => {
    const io = createIo();
    const deps = createDeps();
    await expect(dispatchAuthCommand(["auth", "login", "kimi"], io, deps)).resolves.toBe(0);
    expect(mocks.runAuthLoginFlow).toHaveBeenCalledWith(["kimi"], io, deps);
  });

  it("logs out the stable Kimi provider ID", async () => {
    const io = createIo();
    await expect(dispatchAuthCommand(["auth", "logout", "kimi"], io, createDeps())).resolves.toBe(0);
    expect(mocks.deleteApiKey).toHaveBeenCalledWith("Claude Code with Moonshot Kimi");
    expect(io.stdout.output).toContain("signed out");
  });

  it("logs out the stable OpenCode Go provider ID", async () => {
    const io = createIo();
    await expect(dispatchAuthCommand(["auth", "logout", "opencode"], io, createDeps())).resolves.toBe(0);
    expect(mocks.deleteApiKey).toHaveBeenCalledWith("Claude Code with OpenCode Go");
    expect(io.stdout.output).toContain("OpenCode Go for AI Gateway signed out");
  });

  it("rejects an unknown logout provider without prompting", async () => {
    const io = createIo();
    await expect(dispatchAuthCommand(["auth", "logout", "bogus"], io, createDeps())).resolves.toBe(1);
    expect(mocks.deleteApiKey).not.toHaveBeenCalled();
    expect(io.stderr.output).toContain("Unknown fleet gateway auth provider: bogus");
    expect(io.stderr.output).toContain("Use kimi or opencode.");
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
