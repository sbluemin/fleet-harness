import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAuthService,
  resolveAuthEnv,
} from "../../src/auth/index.js";

const tempRoots: string[] = [];

describe("auth providers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const tempRoot of tempRoots.splice(0)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns no env for providers without Fleet auth overlay", async () => {
    await expect(resolveAuthEnv("claude")).resolves.toEqual({});
  });

  it("runs validation before returning Claude-family auth env", async () => {
    const authPath = createTempAuthPath();
    const auth = createAuthService({ authPath });
    await auth.setApiKey("Claude Code with Z.AI GLM", "zai-token");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await expect(resolveAuthEnv("claude-zai", { authService: auth })).resolves.toEqual({
      ANTHROPIC_AUTH_TOKEN: "zai-token",
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      API_TIMEOUT_MS: "3000000",
    });
    expect(fetchMock).toHaveBeenCalledWith("https://api.z.ai/api/anthropic/v1/messages", expect.objectContaining({
      headers: expect.objectContaining({
        "x-api-key": "zai-token",
      }),
    }));
  });

  it("derives Kimi auth env from CLI_BACKENDS identical to the historical literal values", async () => {
    const authPath = createTempAuthPath();
    const auth = createAuthService({ authPath });
    await auth.setApiKey("Claude Code with Moonshot Kimi", "kimi-token");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    // CLI_BACKENDS.defaultEnv 파생 결과가 기존 하드코딩 값과 byte 동일함을 고정한다
    await expect(resolveAuthEnv("claude-kimi", { authService: auth })).resolves.toEqual({
      ANTHROPIC_AUTH_TOKEN: "kimi-token",
      ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
      ENABLE_TOOL_SEARCH: "false",
      ANTHROPIC_MODEL: "kimi-k2.7-code",
      CLAUDE_CODE_SUBAGENT_MODEL: "kimi-k2.7-code",
      API_TIMEOUT_MS: "3000000",
    });
    // baseUrl 파생 값도 기존 리터럴과 동일한 검증 URL을 만들어야 한다
    expect(fetchMock).toHaveBeenCalledWith("https://api.kimi.com/coding/v1/messages", expect.anything());
  });

  it("fails before returning env when the stored key is missing", async () => {
    const authPath = createTempAuthPath();
    const auth = createAuthService({ authPath });

    await expect(resolveAuthEnv("claude-kimi", { authService: auth })).rejects.toThrow("fleet auth login");
  });

  it("fails before returning env when validation rejects the stored key", async () => {
    const authPath = createTempAuthPath();
    const auth = createAuthService({ authPath });
    await auth.setApiKey("Claude Code with Moonshot Kimi", "kimi-token");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("forbidden", { status: 403 }));

    await expect(resolveAuthEnv("claude-kimi", { authService: auth })).rejects.toThrow("Auth token is not allowed for this provider");
  });
});

function createTempAuthPath(): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-auth-provider-"));
  tempRoots.push(tempRoot);
  return path.join(tempRoot, ".fleet", "auth.json");
}
