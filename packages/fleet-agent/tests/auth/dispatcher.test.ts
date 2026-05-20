import { beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchAuthCommand } from "../../src/auth/dispatcher.js";

const mocks = vi.hoisted(() => ({
  cancelMock: vi.fn(),
  deleteApiKeyMock: vi.fn(),
  listProviderIdsMock: vi.fn(),
  migrateLegacyAuthStoreMock: vi.fn(),
  runAuthLoginFlowMock: vi.fn(),
  selectMock: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  cancel: mocks.cancelMock,
  isCancel: (value: unknown) => value === Symbol.for("clack.cancel"),
  select: mocks.selectMock,
}));

vi.mock("../../src/auth/login-flow.js", () => ({
  getAuthCliOptions: () => ["claude-zai", "claude-kimi"],
  parseAuthCliId: (value: string | undefined) => (
    value === "claude-zai" || value === "claude-kimi" ? value : undefined
  ),
  runAuthLoginFlow: mocks.runAuthLoginFlowMock,
}));

vi.mock("@sbluemin/fleet-core", () => ({
  infra: {
    auth: {
      AUTH_LIST_EMPTY_MESSAGE: "No auth tokens",
      AUTH_COMMAND_CANCELLED_MESSAGE: "Cancelled",
      AUTH_LOGOUT_PROVIDER_PROMPT_MESSAGE: "Select provider",
      CLI_TO_AUTH_PROVIDER_ID: {
        "claude-zai": "Claude Code with Z.AI GLM",
        "claude-kimi": "Claude Code with Moonshot Kimi",
      },
      createAuthService: () => ({
        deleteApiKey: mocks.deleteApiKeyMock,
        listProviderIds: mocks.listProviderIdsMock,
      }),
      formatAuthLogoutSuccessMessage: (providerId: string) => `Removed: ${providerId}`,
      formatAuthMigrationNotice: () => "Migration complete",
      migrateLegacyAuthStore: mocks.migrateLegacyAuthStoreMock,
    },
  },
}));

describe("auth dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.migrateLegacyAuthStoreMock.mockResolvedValue({ shouldPrintNotice: false });
    mocks.listProviderIdsMock.mockResolvedValue([]);
    mocks.deleteApiKeyMock.mockResolvedValue(true);
    mocks.runAuthLoginFlowMock.mockResolvedValue(0);
    mocks.selectMock.mockResolvedValue("claude-zai");
  });

  it("prints help for fleet auth --help", async () => {
    const io = createIo();

    await expect(dispatchAuthCommand(["auth", "--help"], io)).resolves.toBe(0);

    expect(io.stdout.output).toContain("fleet auth login");
  });

  it("dispatches login without touching list or logout storage paths", async () => {
    const io = createIo();

    await expect(dispatchAuthCommand(["auth", "login", "claude-zai"], io)).resolves.toBe(0);

    expect(mocks.runAuthLoginFlowMock).toHaveBeenCalledWith(["claude-zai"], io);
    expect(mocks.listProviderIdsMock).not.toHaveBeenCalled();
    expect(mocks.deleteApiKeyMock).not.toHaveBeenCalled();
  });

  it("lists provider labels without exposing key material", async () => {
    const io = createIo();
    mocks.listProviderIdsMock.mockResolvedValue(["Claude Code with Z.AI GLM"]);

    await expect(dispatchAuthCommand(["auth", "list"], io)).resolves.toBe(0);

    expect(io.stdout.output).toContain("Claude Code with Z.AI GLM");
    expect(io.stdout.output).not.toContain("secret");
  });

  it("prints the core empty-state message when no providers are configured", async () => {
    const io = createIo();

    await expect(dispatchAuthCommand(["auth", "list"], io)).resolves.toBe(0);

    expect(io.stdout.output).toContain("No auth tokens");
  });

  it("logs out a selected provider", async () => {
    const io = createIo();

    await expect(dispatchAuthCommand(["auth", "logout", "claude-kimi"], io)).resolves.toBe(0);

    expect(mocks.deleteApiKeyMock).toHaveBeenCalledWith("Claude Code with Moonshot Kimi");
    expect(io.stdout.output).toContain("Removed: Claude Code with Moonshot Kimi");
  });

  it("prompts for logout provider when no backend is supplied", async () => {
    const io = createIo();

    await expect(dispatchAuthCommand(["auth", "logout"], io)).resolves.toBe(0);

    expect(mocks.selectMock).toHaveBeenCalled();
    expect(mocks.deleteApiKeyMock).toHaveBeenCalledWith("Claude Code with Z.AI GLM");
  });

  it("rejects unknown subcommands", async () => {
    const io = createIo();

    await expect(dispatchAuthCommand(["auth", "unknown"], io)).resolves.toBe(1);

    expect(io.stderr.output).toContain("Unknown fleet auth command");
  });
});

function createIo() {
  const stdout = {
    output: "",
    write(chunk: string) {
      stdout.output += chunk;
      return true;
    },
  };
  const stderr = {
    output: "",
    write(chunk: string) {
      stderr.output += chunk;
      return true;
    },
  };
  return { stdout, stderr };
}
