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

vi.mock("@fleet-console/ai-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fleet-console/ai-gateway")>();
  return {
    ...actual,
    validateTypesafeAuthKey: mocks.validate,
  };
});

describe("TypeSafe auth login flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.password.mockResolvedValue("typesafe-secret");
    mocks.validate.mockResolvedValue({ providerId: "Fleet Console with TypeSafe System One", status: "success" });
  });

  it("validates before saving the TypeSafe API key", async () => {
    const io = createIo();
    await expect(runAuthLoginFlow(["typesafe"], io, createDeps())).resolves.toBe(0);
    expect(mocks.validate).toHaveBeenCalledWith("typesafe-secret");
    expect(mocks.setApiKey).toHaveBeenCalledWith("Fleet Console with TypeSafe System One", "typesafe-secret");
  });

  it("does not save a rejected key", async () => {
    const io = createIo();
    mocks.validate.mockResolvedValue({ providerId: "Fleet Console with TypeSafe System One", status: "unauthorized" });
    await expect(runAuthLoginFlow(["typesafe"], io, createDeps())).resolves.toBe(1);
    expect(mocks.setApiKey).not.toHaveBeenCalled();
    expect(io.stderr.output).toContain("rejected");
  });

  it("rejects an unknown provider argument instead of opening a picker", async () => {
    const io = createIo();
    await expect(runAuthLoginFlow(["bogus"], io, createDeps())).resolves.toBe(1);
    expect(mocks.password).not.toHaveBeenCalled();
    expect(mocks.setApiKey).not.toHaveBeenCalled();
    expect(io.stderr.output).toBe("Unknown provider: bogus\nUse one of: typesafe.\n");
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
      getEntry: vi.fn(),
      setEntry: vi.fn(),
      updateEntry: vi.fn(),
      listProviderIds: vi.fn(),
      setApiKey: mocks.setApiKey,
    },
  };
}
