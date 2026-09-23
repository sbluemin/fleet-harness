import { beforeEach, describe, expect, it, vi } from "vitest";

import { runAuthLoginFlow } from "../../../cli/auth/login-flow.js";
import { dispatchAuthCommand } from "../../../cli/auth/dispatcher.js";

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
    validateOpencodeGoAuthKey: mocks.validate,
  };
});

describe("OpenCode Go auth login flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.password.mockResolvedValue("opencode-secret");
    mocks.validate.mockResolvedValue({ providerId: "Claude Code with OpenCode Go", status: "success" });
  });

  it("validates before saving the OpenCode Go API key", async () => {
    const io = createIo();
    await expect(runAuthLoginFlow(["opencode"], io, createDeps())).resolves.toBe(0);
    expect(mocks.validate).toHaveBeenCalledWith("opencode-secret");
    expect(mocks.setApiKey).toHaveBeenCalledWith("Claude Code with OpenCode Go", "opencode-secret");
  });

  it("does not save a rejected key", async () => {
    const io = createIo();
    mocks.validate.mockResolvedValue({ providerId: "Claude Code with OpenCode Go", status: "unauthorized" });
    await expect(runAuthLoginFlow(["opencode"], io, createDeps())).resolves.toBe(1);
    expect(mocks.setApiKey).not.toHaveBeenCalled();
    expect(io.stderr.output).toContain("rejected");
  });

  it("lets users delete a retired credential without restoring its login", async () => {
    const legacyId = "Claude Code with Moonshot Kimi";
    const activeId = "Claude Code with OpenCode Go";
    const keys = new Map([[legacyId, "legacy-key"], [activeId, "active-key"]]);
    const deps = {
      authService: {
        getApiKey: async (id: string) => keys.get(id),
        setApiKey: mocks.setApiKey,
        listProviderIds: async () => [...keys.keys()],
        deleteApiKey: async (id: string) => keys.delete(id),
      },
    };
    await expect(dispatchAuthCommand(["auth", "login", "kimi"], createIo(), deps)).resolves.toBe(1);
    expect(keys.has(legacyId)).toBe(true);
    expect(mocks.password).not.toHaveBeenCalled();
    await expect(dispatchAuthCommand(["auth", "logout", "kimi"], createIo(), deps)).resolves.toBe(0);
    expect([...keys.entries()]).toEqual([[activeId, "active-key"]]);
  });

  it("rejects an unknown provider argument instead of opening a picker", async () => {
    const io = createIo();
    await expect(runAuthLoginFlow(["bogus"], io, createDeps())).resolves.toBe(1);
    expect(mocks.password).not.toHaveBeenCalled();
    expect(mocks.setApiKey).not.toHaveBeenCalled();
    expect(io.stderr.output).toBe("Unknown fleet gateway auth provider: bogus\nUse one of: opencode, typesafe.\n");
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
