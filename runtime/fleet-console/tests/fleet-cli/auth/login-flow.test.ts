import { beforeEach, describe, expect, it, vi } from "vitest";

import { runAuthLoginFlow } from "../../../cli/auth/login-flow.js";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  password: vi.fn(),
  setApiKey: vi.fn(),
  validate: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  cancel: mocks.cancel,
  isCancel: (value: unknown) => value === Symbol.for("clack.cancel"),
  password: mocks.password,
  select: vi.fn(),
}));

vi.mock("@dotobokuri/fleet-admiral", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dotobokuri/fleet-admiral")>();
  return {
    ...actual,
    validateKimiAuthKey: mocks.validate,
  };
});

describe("Kimi auth login flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.password.mockResolvedValue("kimi-secret");
    mocks.validate.mockResolvedValue({ providerId: "Claude Code with Moonshot Kimi", status: "success" });
  });

  it("validates before saving the Kimi API key", async () => {
    const io = createIo();
    await expect(runAuthLoginFlow(["kimi"], io, createDeps())).resolves.toBe(0);
    expect(mocks.validate).toHaveBeenCalledWith("kimi-secret");
    expect(mocks.setApiKey).toHaveBeenCalledWith("Claude Code with Moonshot Kimi", "kimi-secret");
  });

  it("does not save a rejected key", async () => {
    const io = createIo();
    mocks.validate.mockResolvedValue({ providerId: "Claude Code with Moonshot Kimi", status: "unauthorized" });
    await expect(runAuthLoginFlow(["kimi"], io, createDeps())).resolves.toBe(1);
    expect(mocks.setApiKey).not.toHaveBeenCalled();
    expect(io.stderr.output).toContain("rejected");
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
      deleteApiKey: vi.fn(),
      getApiKey: vi.fn(),
      listProviderIds: vi.fn(),
      setApiKey: mocks.setApiKey,
    },
  };
}
