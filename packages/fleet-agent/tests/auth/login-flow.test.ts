import { beforeEach, describe, expect, it, vi } from "vitest";

import { runAuthLoginFlow } from "../../src/auth/login-flow.js";

const mocks = vi.hoisted(() => ({
  cancelMock: vi.fn(),
  migrateLegacyAuthStoreMock: vi.fn(),
  passwordMock: vi.fn(),
  selectMock: vi.fn(),
  setApiKeyMock: vi.fn(),
  validateAuthKeyForCliMock: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  cancel: mocks.cancelMock,
  isCancel: (value: unknown) => value === Symbol.for("clack.cancel"),
  password: mocks.passwordMock,
  select: mocks.selectMock,
}));

vi.mock("@sbluemin/fleet-core", () => ({
  infra: {
    auth: {
      CLI_TO_AUTH_PROVIDER_ID: {
        "claude-zai": "Claude Code with Z.AI GLM",
        "claude-kimi": "Claude Code with Moonshot Kimi",
      },
      createAuthService: () => ({
        setApiKey: mocks.setApiKeyMock,
      }),
      formatAuthLoginSuccessMessage: (providerId: string) => `등록 완료: ${providerId}`,
      formatAuthMigrationNotice: () => "이전 완료",
      formatAuthValidationFailureMessage: () => "검증 실패",
      migrateLegacyAuthStore: mocks.migrateLegacyAuthStoreMock,
      validateAuthKeyForCli: mocks.validateAuthKeyForCliMock,
    },
  },
}));

describe("auth login flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.passwordMock.mockResolvedValue("secret-token");
    mocks.migrateLegacyAuthStoreMock.mockResolvedValue({ shouldPrintNotice: false });
    mocks.validateAuthKeyForCliMock.mockResolvedValue({
      providerId: "Claude Code with Z.AI GLM",
      status: "success",
    });
  });

  it("validates before saving the selected provider key", async () => {
    const io = createIo();

    await expect(runAuthLoginFlow(["claude-zai"], io)).resolves.toBe(0);

    expect(mocks.validateAuthKeyForCliMock).toHaveBeenCalledWith("claude-zai", "secret-token");
    expect(mocks.setApiKeyMock).toHaveBeenCalledWith("Claude Code with Z.AI GLM", "secret-token");
    expect(io.stdout.output).toContain("등록 완료: Claude Code with Z.AI GLM");
  });

  it("prompts for a backend when one is not supplied", async () => {
    const io = createIo();
    mocks.selectMock.mockResolvedValue("claude-kimi");
    mocks.validateAuthKeyForCliMock.mockResolvedValue({
      providerId: "Claude Code with Moonshot Kimi",
      status: "success",
    });

    await expect(runAuthLoginFlow([], io)).resolves.toBe(0);

    expect(mocks.selectMock).toHaveBeenCalled();
    expect(mocks.validateAuthKeyForCliMock).toHaveBeenCalledWith("claude-kimi", "secret-token");
    expect(mocks.setApiKeyMock).toHaveBeenCalledWith("Claude Code with Moonshot Kimi", "secret-token");
  });

  it("does not save when validation fails", async () => {
    const io = createIo();
    mocks.validateAuthKeyForCliMock.mockResolvedValue({
      providerId: "Claude Code with Z.AI GLM",
      status: "forbidden",
    });

    await expect(runAuthLoginFlow(["claude-zai"], io)).resolves.toBe(1);

    expect(mocks.setApiKeyMock).not.toHaveBeenCalled();
    expect(io.stderr.output).toContain("검증 실패");
  });

  it("cancels without saving when secret entry is cancelled", async () => {
    const io = createIo();
    mocks.passwordMock.mockResolvedValue(Symbol.for("clack.cancel"));

    await expect(runAuthLoginFlow(["claude-zai"], io)).resolves.toBe(1);

    expect(mocks.cancelMock).toHaveBeenCalled();
    expect(mocks.setApiKeyMock).not.toHaveBeenCalled();
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
